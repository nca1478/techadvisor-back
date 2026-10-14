# TechAdvisor — Backend

API NestJS para el ecommerce B2C de tecnología TechAdvisor con asesor de compras RAG.
Escucha en el puerto **3001** con prefijo global **`/api/v1`**.

> Fuente de verdad: [`../AGENTS.md`](../AGENTS.md).

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

## Infraestructura (PostgreSQL + pgvector, Redis)

La infraestructura local corre con Docker Compose desde esta carpeta (`backend/`).
La API y la web corren con `npm run dev` — sin Dockerfiles.

```bash
cp .env.example .env          # una vez: crea tu env local (nunca commitees .env)
docker compose up -d          # arranca postgres (5433) + redis (6379) + stripe-mock (12111/12112)
docker compose ps             # los servicios deben salir "healthy"
docker compose down           # detiene la infraestructura (conserva los volúmenes)
docker compose down -v        # detiene Y borra los volúmenes (arranque limpio)
```

## Base de datos (Prisma)

```bash
npx prisma migrate dev   # aplica migraciones pendientes (crea la BD si falta)
npx prisma generate      # regenera el cliente (también corre en `npm ci` vía `postinstall`)
```

## Seed (solo datos de desarrollo)

Fixtures idempotentes: 7 categorías, 10 marcas, 40 productos (portátiles +
componentes de PC con specs coherentes), traducciones ES y dos usuarios de
prueba. Los datos viven en `prisma/seed-data/*.json` y se validan contra los
esquemas Zod de specs por categoría en cada ejecución. Se puede correr
repetidamente sin riesgo — los upserts por `slug`/`sku`/email convergen en vez
de duplicar.

```bash
npm run seed             # se niega a correr con NODE_ENV=production
```

## Políticas del asesor posventa (RAG)

Plantillas de ejemplo de garantía, envíos, devoluciones, métodos de pago y
privacidad en `docs/content/policies/<locale>/*.md` (es y en), marcadas como
plantilla a revisar por el negocio. Se ingieren como documentos `POLICY` para
el endpoint `POST /api/v1/advisor/support` (ver ADR `0036`):

```bash
npm run seed:policies    # idempotente: omite lo que no cambió; también se niega en producción
```

## Corpus RAG del asesor (fichas, FAQ, garantía, políticas)

El corpus curado que ve el panel `/admin/documentos` y alimenta a los
asesores (producto-QA sobre SPEC_SHEET; soporte sobre POLICY/WARRANTY/FAQ,
ver ADR `0048`):

- **Ficha técnica por producto** (`SPEC_SHEET`, `source = 'auto:product'`):
  una por cada producto ACTIVE, generada desde la fila del catálogo.
- **FAQ** (`docs/content/faqs/<locale>/*.md`, `type: FAQ`).
- **Garantía** (`docs/content/warranty/<locale>/*.md`, `type: WARRANTY`).
- **Políticas** (`docs/content/policies/<locale>/*.md`, `type: POLICY`).

```bash
npm run seed:documents  # superset idempotente de seed:policies + fichas + FAQ + garantía; también se niega en producción
```

Re-ejecutarlo converge sin duplicar chunks (omite lo no cambiado por
`content_hash`) y reaviva filas seed borradas desde el admin. Manuales
(`source = 'manual'`) nunca se tocan.

Usuarios de prueba (solo desarrollo local, nunca producción):

| Rol      | Email                        | Contraseña     |
| -------- | ---------------------------- | -------------- |
| ADMIN    | `admin@techadvisor.local`    | `Admin123!`    |
| CUSTOMER | `customer@techadvisor.local` | `Customer123!` |

## Scripts

| Script                     | Qué hace                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`              | arranca en modo watch (puerto 3001)                                                      |
| `npm run seed`             | carga datos de desarrollo/demo                                                           |
| `npm run seed:policies`      | ingiere las políticas de ejemplo como documentos `POLICY` (idempotente)                  |
| `npm run seed:documents`     | ingiere el corpus RAG curado (SPEC_SHEET por producto + FAQ + WARRANTY + POLICY, idempotente) |
| `npm run build`            | compila a `dist/`                                                                        |
| `npm run worker:ingestion` | corre el worker de ingesta RAG (desde `dist/`, requiere `npm run build` antes)           |
| `npm run worker:reindex`   | corre el worker de reindex de embeddings (desde `dist/`, requiere `npm run build` antes) |
| `npm run lint`             | oxlint (con tipos)                                                                       |
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
arriba. Deja `STRIPE_BASE_URL` vacío para volver a la API test real.

## Estructura

- `src/modules/` — módulos de funcionalidad (catalog, orders, …)
- `src/common/` — filtros, guards, interceptors, utils
- `src/config/` — configuración validada por env
