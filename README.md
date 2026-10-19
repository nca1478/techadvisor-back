# TechAdvisor — Backend

API NestJS para el ecommerce B2C de tecnología TechAdvisor con asesor de compras RAG.
Escucha en el puerto **3001** con prefijo global **`/api/v1`**.

> Fuente de verdad: [`../AGENTS.md`](../AGENTS.md).

Estado: ecommerce completo (auth, catálogo i18n, inventario, carrito,
órdenes, pagos Stripe test, panel admin) + RAG completo (ingesta,
búsqueda híbrida, product-QA, asesor conversacional, comparador,
soporte posventa, reseñas con resumen) + evaluación y observabilidad
(Fases 0–7). Decisiones en `docs/decisions/` (64 ADRs).

## Ejecución

```bash
npm ci
npm run dev      # modo watch en http://localhost:3001
```

> Subir documentos RAG (panel admin) también requiere el worker de ingesta:
> la API solo encola y un proceso aparte consume la cola (ver
> [Worker de ingesta](#worker-de-ingesta-rag)). Sin él, los documentos se
> quedan en `PENDING` para siempre. Segunda terminal:
>
> ```bash
> npm run build && npm run worker:ingestion
> ```

## Infraestructura (PostgreSQL + pgvector, Redis, stripe-mock)

La infraestructura local corre con Docker Compose desde esta carpeta (`backend/`).
La API y la web corren con `npm run dev` — sin Dockerfiles.

```bash
cp .env.example .env          # una vez: crea tu env local (nunca commitees .env)
docker compose up -d          # arranca postgres (5433) + redis (6379) + stripe-mock (12111/12112)
docker compose ps             # los servicios deben salir "healthy"
docker compose down           # detiene la infraestructura (conserva los volúmenes)
docker compose down -v        # detiene Y borra los volúmenes (arranque limpio)
```

## Despliegue en Render (tier free)

Un solo Web Service free (`techadvisor-back`) con API + worker de ingesta en
el mismo contenedor vía `npm run start:free` (ver ADRs `0066`, `0067`, `0070`).
El Blueprint versionado es `render.yaml`. El Dashboard debe usar exactamente:

- Build: `npm ci && npx prisma generate && npm run build`
- Pre-deploy: `npx prisma migrate deploy`
- Start: `npm run start:free`
- Health check: `/api/v1/health`

`npm run db:setup` es solo para desarrollo local: los seeds se niegan con
`NODE_ENV=production` y migrar dentro del build rompió un deploy con P3018
(`type "Role" already exists`). Si `migrate deploy` reporta migraciones ya
aplicadas en la BD pero no registradas, resolver una vez con
`npx prisma migrate resolve --applied "<nombre>"` y reintentar el deploy.

## Base de datos (Prisma)

```bash
npm run db:generate    # regenera el cliente (también corre en `npm ci` vía `postinstall`)
npm run db:migrate     # aplica migraciones pendientes (crea la BD si falta)
```

Migraciones siempre aditivas (28 migraciones: auth, catálogo, inventario,
carrito, órdenes, pagos, corpus RAG, sesiones del asesor, reseñas,
observabilidad). Ver `prisma/migrations/`.

## Seed (solo datos de desarrollo)

Fixtures idempotentes: 7 categorías, 10 marcas, 40 productos (portátiles +
componentes de PC con specs coherentes), traducciones ES y EN, y dos usuarios
de prueba. Los datos viven en `prisma/seed-data/*.json` y se validan contra los
esquemas Zod de specs por categoría en cada ejecución. Se puede correr
repetidamente sin riesgo — los upserts por `slug`/`sku`/email convergen en vez
de duplicar.

```bash
npm run db:seed        # catálogo + usuarios; se niega con NODE_ENV=production
```

Usuarios de prueba (solo desarrollo local, nunca producción):

| Rol      | Email                        | Contraseña     |
| -------- | ---------------------------- | -------------- |
| ADMIN    | `admin@techadvisor.local`    | `Admin123!`    |
| CUSTOMER | `customer@techadvisor.local` | `Customer123!` |

## Corpus RAG del asesor (fichas, FAQ, garantía, políticas)

El corpus curado que ve el panel `/admin/documentos` y alimenta a los
asesores (producto-QA sobre SPEC_SHEET; soporte sobre POLICY/WARRANTY/FAQ,
ver ADRs `0036` y `0048`):

- **Ficha técnica por producto** (`SPEC_SHEET`, `source = 'auto:product'`):
  una por cada producto ACTIVE, generada desde la fila del catálogo y
  re-sincronizada al escribir productos.
- **FAQ** (`docs/content/faqs/<locale>/*.md`, `type: FAQ`).
- **Garantía** (`docs/content/warranty/<locale>/*.md`, `type: WARRANTY`).
- **Políticas** (`docs/content/policies/<locale>/*.md`, `type: POLICY`;
  plantillas de ejemplo de garantía, envíos, devoluciones, métodos de pago y
  privacidad, marcadas como plantilla a revisar por el negocio).

```bash
npm run db:seed:documents  # superset idempotente (alias: seed:documents); también se niega en producción
```

Re-ejecutarlo converge sin duplicar chunks (omite lo no cambiado por
`content_hash`) y reaviva filas seed borradas desde el admin. Manuales
(`source = 'manual'`) nunca se tocan.

## API

Prefijo `/api/v1`, errores uniformes `{ statusCode, code, message, details? }`.
Contrato OpenAPI en `GET /api/v1/docs-json` (solo no-producción o protegido;
ver ADR `0004`).

| Grupo | Endpoints principales |
| ----- | --------------------- |
| Sistema | `GET /health`, `GET /config/public` (moneda base, monedas, locales) |
| Auth | registro, login, refresh, logout (`/auth/*`, rate limit) |
| Catálogo | `GET /catalog/*` (listado con filtros/orden/paginación, detalle, specs por categoría) |
| Inventario | reserva al crear orden; admin ajusta stock |
| Carrito | invitado y autenticado, merge al iniciar sesión (`/cart/*`) |
| Órdenes | creación, listado, máquina de estados + expiración (`/orders/*`) |
| Pagos | `POST /payments/checkout`, `POST /payments/webhook` (firma verificada, idempotente) |
| Búsqueda | `GET /search` (`q` opcional: vacía explora por categoría/precio solo-SQL; con texto, semántica híbrida + fallback léxico, rate limit) |
| Asesor | `POST /advisor/product-qa`, `POST /advisor/compare`, `POST /advisor/support`, `POST /advisor/feedback`, sesiones `GET+POST /advisor/sessions`, `GET+POST+DELETE /advisor/sessions/:id(+/messages)` |
| Compatibilidad | `POST /compatibility/check` (reglas deterministas sobre `specs`) |
| Reseñas | `POST /reviews`, `GET /reviews/product/:id(+/summary)`; moderación en admin |
| Admin | CRUD productos/categorías/marcas, inventario, órdenes, `GET /admin/metrics/overview`, documentos, reindex, panel del asesor (sin respuesta, feedback) |
| Observabilidad | log de llamadas IA solo-metadata (proveedor, modelo, latencia, tokens, costo estimado) |

Principio rector: precio, stock, specs y garantías se leen de SQL o de
documentos recuperados; el LLM solo explica y recomienda, con citas `[1]`,
`[2]` validadas contra los chunks entregados. Sin evidencia suficiente, el
asesor se abstiene y registra en `UnansweredQuery`.

## IA agnóstica al proveedor

Todo el código de negocio depende de las interfaces `LlmProvider` y
`EmbeddingProvider` (`src/modules/ai/`); los SDKs viven solo en
`src/modules/ai/adapters/`. Cambiar de modelo es solo configuración.

Adapters LLM: `fake` (offline/dev/tests), `openai-compatible`
(`/chat/completions` + SSE), `openai-responses` (formato `/responses`),
`anthropic` (nativo). Adapters de embeddings: `fake`, `openai-compatible`
(por defecto: `text-embedding-3-small`, 1536 dims), `nvidia` (nativo,
`nemotron-3-embed-1b`, halfvec 2048). Ver ADRs `0016`–`0018`, `0024`,
`0026`–`0028` y las variables `LLM_*` / `EMBEDDING_*` en `.env.example`.
Prompts versionados en `docs/rag/prompts/` (`product-qa`, `intent`,
`recommend`, `compare`, `support`, `review-summary`).

## Scripts

| Script                     | Qué hace                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`              | arranca en modo watch (puerto 3001; alias `start:dev`)                                   |
| `npm run build`            | compila a `dist/`                                                                        |
| `npm run db:generate`      | regenera el cliente Prisma                                                               |
| `npm run db:migrate`       | aplica migraciones (`prisma migrate dev`)                                                |
| `npm run db:seed`          | carga catálogo + usuarios de desarrollo (idempotente)                                    |
| `npm run db:seed:policies` | ingiere las políticas de ejemplo como documentos `POLICY` (idempotente)                  |
| `npm run db:seed:documents`| ingiere el corpus RAG curado (SPEC_SHEET por producto + FAQ + WARRANTY + POLICY, idempotente; alias `seed:documents`) |
| `npm run worker:ingestion` | corre el worker de ingesta RAG (desde `dist/`, requiere `npm run build` antes)           |
| `npm run worker:reindex`   | corre el worker de reindex de embeddings (desde `dist/`, requiere `npm run build` antes) |
| `npm run eval`             | evaluación RAG (ver [Evaluación](#evaluación-rag))                                       |
| `npm run lint`             | eslint                                                                                   |
| `npm run typecheck`        | `tsc --noEmit`                                                                           |
| `npm test`                 | tests unitarios (vitest)                                                                 |
| `npm run test:e2e`         | tests e2e de la API (vitest + supertest)                                                 |

## Worker de ingesta (RAG)

Los documentos se convierten en chunks con embeddings a través de la cola
BullMQ `ingestion` (ver ADR `0019`): la API solo encola y este proceso aparte
consume:

```bash
npm run build && npm run worker:ingestion
```

Cada producto ACTIVE tiene un documento SPEC_SHEET autogenerado
(`source = 'auto:product'`), re-sincronizado al escribir productos. Reingestar
contenido sin cambios es un no-op (mismo `content_hash` → skip, sin llamar al
proveedor). Los fallos dejan el documento en `FAILED` con un error legible y
BullMQ espera con backoff entre intentos (`INGESTION_MAX_ATTEMPTS`,
`INGESTION_BACKOFF_MS`).

## Reindex de embeddings (cambio de modelo, cero downtime)

Cambiar de modelo de embeddings nunca reescribe la columna viva en el sitio
(ver ADR `0023` para el runbook completo y el rollback):

```bash
npm run build && npm run worker:reindex
```

1. Apunta `EMBEDDING_MODEL` / `EMBEDDING_DIM` al modelo NUEVO y reinicia.
2. `POST /api/v1/admin/reindex` — snapshot de cada chunk y encola un job de
   la cola `reindex` por lote; la búsqueda sigue sirviendo el modelo ACTIVO.
3. Consulta `GET /api/v1/admin/reindex/jobs/:id` hasta que `activatable` sea
   true (`resume` re-encola lo que siga sin vectores).
4. `POST /api/v1/admin/reindex/jobs/:id/activate` — cambia retrieval al
   modelo nuevo solo al 100% sin fallos. La columna vieja se conserva.

## Pagos (Stripe, solo modo test)

Los checkouts corren detrás de la interfaz `PaymentProvider` (ver ADR `0012`):
`POST /api/v1/payments/checkout { orderId }` crea una Checkout Session
alojada en Stripe desde el total del pedido en servidor y devuelve su URL.
El webhook de Stripe es la **única** fuente de verdad del estado del pago:
`POST /api/v1/payments/webhook` verifica la cabecera `stripe-signature` sobre
el cuerpo crudo y mueve la orden a `PAID` (o a `CANCELLED` si el pago
falla/expira). La redirección `success_url` del frontend nunca cambia el
estado de la orden. Solo se aceptan claves de test (`sk_test_...` /
`pk_test_...`; las live tumban el arranque). Sin claves, `/payments/*`
responde `503`.

```bash
# Test end-to-end local con el Stripe CLI (requiere claves test en .env):
stripe login
stripe listen --all-snapshot --forward-to localhost:3001/api/v1/payments/webhook
# En otra terminal, para activar eventos con CLI
stripe trigger payment_intent.succeeded
```

### Stripe offline con stripe-mock (sin red ni cuenta)

`docker compose up -d` incluye `stripe-mock` (puertos `12111` HTTP y
`12112` HTTPS). Para crear Checkout Sessions contra el mock en vez de la
API real, pon en tu `.env` (ver ADR `0051`):

```bash
STRIPE_BASE_URL=http://localhost:12111
```

El mock devuelve fixtures con ids/URLs fijos y no envía webhooks reales,
así que los flujos de webhook se siguen probando con el Stripe CLI de
arriba. Esas URLs fixture NO son pagables: abrir una en el navegador
muestra la página "This link is incomplete" de Stripe; es el
comportamiento esperado del mock, no un bug. Deja `STRIPE_BASE_URL` vacío para volver a la API test real.

## Evaluación RAG

Dataset `eval/qa.jsonl` (54 preguntas: respondibles, no respondibles,
adversariales/prompt injection) + umbrales en `eval/thresholds.json`
(recall@5, abstención correcta, citas válidas, cero alucinaciones).
Ver ADRs `0038` y `0041`; guía en `docs/rag/evaluacion.md`.

```bash
npm run eval              # reporte con el dataset completo
npm run eval -- --offline # sin llamadas a IA (retrieval + citas)
npm run eval -- --strict  # falla si no se cumplen los umbrales (puerta de CI)
```

El script acepta proveedor y modelo por env/flags para comparar modelos con
el mismo dataset; los resultados se guardan por modelo en `eval/results/`.

## Verificación (tras cada tarea, en esta carpeta)

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
docker compose up -d && curl -f http://localhost:3001/api/v1/health
npm run eval -- --offline
```

## Estructura

- `src/modules/` — funcionalidad (auth, catalog, inventory, cart, orders,
  payments, admin, ai, ingestion, reindex, retrieval, search, advisor,
  compatibility, reviews, observability, …)
- `src/common/` — filtros, guards, interceptors, utils
- `src/config/` — configuración validada por env (Zod)
- `prisma/` — esquema, migraciones, seed y seed-data
- `docs/decisions/` — ADRs del backend
- `docs/rag/prompts/` — prompts versionados del asesor
- `docs/content/` — FAQ, garantías y políticas a ingestar (es/en)
- `eval/` — dataset, harness y umbrales de evaluación RAG
