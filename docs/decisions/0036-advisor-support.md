# 0036 — Advisor post-sale support (`POST /advisor/support`)

## Contexto

Fase 6 del plan: responder sobre garantía, envíos, devoluciones y guías con
evidencia citada, reutilizando el patrón de `product-qa` (ADR 0025):
recuperación híbrida + abstención + citas `[n]` validadas por el backend.
Rigen AGENTS.md §5.1 (el LLM nunca inventa condiciones de garantía ni plazos)
y §7 (prompts neutros, sin tool-calling, citas validadas en código).

## Decisión

Nuevo `SupportService` en `src/modules/advisor/support/` detrás de
`POST /advisor/support { question, orderId?, locale? }`:

1. **Recuperación sin filtro de producto.** Se busca sobre
   `docTypes: ['POLICY', 'WARRANTY', 'FAQ']`, sin filtro de producto salvo
   que el contexto lo defina (las políticas son documentos sin producto).
   La opción más simple: un único `retrieval.search` con `topN = 8`
   (`SUPPORT_TOP_N`); no se fusiona con búsquedas por producto porque el
   endpoint no recibe `productId`.
2. **Hechos de la orden desde SQL (opción más simple).** Si se pasa `orderId`,
   el llamante debe estar autenticado (401 anónimo) y la orden debe pertenecer
   al usuario (órdenes ajenas o inexistentes → 404 idéntico, como
   `OrdersService.findOwnedOrder`). Al prompt viajan solo datos estructurados
   mínimos: estado, moneda, total en unidades menores, nº de artículos y fecha
   de creación. Nunca PII (sin email, dirección ni teléfono).
3. **Abstención idéntica a P3.2.** Sin evidencia o mejor score bajo
   `ADVISOR_ABSTAIN_MIN_SCORE` → sin llamada al LLM, fila en
   `unanswered_queries` (`productId: null`, `reason` = `no_evidence` |
   `below_threshold`) y mensaje que deriva a un humano.
4. **Prompt versionado `docs/rag/prompts/support.v1.md`** (neutro, sin
   tool-calling): responder solo con las políticas recuperadas, nunca prometer
   reembolsos, plazos ni excepciones no escritos en ellas; ante una excepción
   no contemplada, derivar al equipo humano en lugar de concederla.
5. **Detección de excepciones en código (opción más simple).** El helper puro
   `isExceptionRequest` detecta peticiones de excepción por palabras clave
   (es/en); cuando salta, el mensaje al LLM añade una nota `EXCEPTION
   REQUEST` que ordena concederla solo si un chunk la contempla explícitamente
   y, en caso contrario, derivar a un humano. El LLM sigue redactando; el
   código no reescribe respuestas.
6. Respuesta: `{ answer, citations[], abstained }` (mismo contrato que
   `product-qa`), reutilizando `buildCitations` y el mapping de errores de
   proveedor de ADR 0026 (503/429 uniformes).
7. **Ingesta de políticas.** Los markdowns de `docs/content/policies/<locale>/`
   se ingieren como `type: POLICY` con `npm run seed:policies`
   (`prisma/seed-policies.ts`, script `tsx` standalone como `seed.ts` porque
   el contexto Nest no arranca bajo `tsx`): upsert idempotente por
   `source = 'seed:policy:<locale>:<nombre>'` + los mismos pasos de
   `IngestionService.ingestDocument` (extract → hash → skip cuando no hay
   cambios → chunk → embeddings → persistencia transaccional) con los mismos
   helpers puros y el `EmbeddingProvider` de la factory. Sin Redis necesario;
   embeddings del proveedor configurado.

## Alternativas consideradas

- Reutilizar `POST /advisor/product-qa` con un producto ficticio: rechazado —
  mezclaría evidencia de producto y exigiría un `productId` sin sentido para
  políticas generales.
- Reescribir en código las respuestas de excepción sin LLM: rechazado — el
  LLM debe poder matizar con la política recuperada; el código solo añade la
  instrucción, no la respuesta.
- Tabla `SupportTicket`: rechazado — fuera del alcance de la tarea; la
  derivación a humano es textual (contacto con soporte).

## Consecuencias

- Sin cambios de BD (sin migraciones): se reutilizan `Document`/`Chunk` con
  `type = POLICY` (ya existe en el enum) y `unanswered_queries`.
- Sin imports de SDKs de IA fuera de `modules/ai/adapters/`.
- Rate limit del throttler `advisor` heredado del controlador.
- Tests unitarios con adapters falsos + e2e contra SQL real.
