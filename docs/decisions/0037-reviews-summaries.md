# 0037 — Reseñas de clientes y resumen pros/contras (`reviews`)

## Contexto

Fase 6, P6.2 del plan: reseñas verificadas por compra y un resumen
pros/contras generado con el `LlmProvider` agnóstico, más la ingesta de
reseñas publicadas como documentos `REVIEW` para el RAG. Rigen AGENTS.md
§5.2 (abstención sin evidencia), §5.10 (sin PII al LLM) y §7 (prompts
neutros, salidas JSON validadas con Zod + un reintento, citas no nativas).

## Decisión

Nuevo `ReviewsModule` en `src/modules/reviews/`:

1. **Modelo.** `Review(id, product_id, user_id, rating 1–5, title ≤120,
   body ≤2000, verified_purchase, status PENDING|PUBLISHED|REJECTED,
   created_at)` con `UNIQUE(product_id, user_id)` (una reseña por
   producto) y `CHECK(rating 1..5)`; `ProductReviewSummary(product_id PK/FK,
   pros/cons JSONB, based_on_count, model)` como caché del resumen.
   Migración `20261010000000_add_reviews`, solo aditiva e idempotente.
2. **Autorización (opción más simple).** Solo compradores: existe una orden
   del usuario en `PAID` o `DELIVERED` que contiene el producto (estados
   posteriores no prueban compra pagada; `PENDING_PAYMENT`/`CANCELLED`
   nunca autorizan). Productos desconocidos o no `ACTIVE` → 404 idéntico.
   Segunda reseña del mismo producto → 409.
3. **Endpoints.** `POST /reviews` (auth, crea `PENDING`),
   `GET /reviews/product/:productId` (público, solo `PUBLISHED`, paginado,
   con `averageRating`, sin `userId` ni `status`),
   `GET /reviews/product/:productId/summary` (público,
   `{ summary: ReviewSummaryDto | null }`, siempre objeto JSON — `summary`
   es `null` bajo el mínimo en lugar de 404 para no tratar "aún sin
   resumen" como error y no romper el parseo JSON con un cuerpo vacío),
   `GET /admin/reviews` (filtros `status`/`productId`) y
   `PATCH /admin/reviews/:id/status` (`PUBLISHED|REJECTED`; re-fijar el
   estado actual es no-op). Todo `/admin/*` con `JwtAuthGuard + @Roles('ADMIN')`.
4. **Ingesta REVIEW (reutiliza el pipeline).** `ReviewIngestionService`
   construye un markdown por producto con las `PUBLISHED` (rating + título
   + cuerpo truncado, sin ids de autor ni emails) y lo upserta como
   `Document(type: REVIEW, source: 'auto:reviews')` encolándolo en la cola
   BullMQ estándar. Sin publicadas (o producto no `ACTIVE`) el documento
   se elimina. Nunca lanza: la moderación no debe romper sin Redis.
5. **Resumen (`ReviewSummaryService.refreshProduct`, "el job").** Con las
   `PUBLISHED` (tope `REVIEW_INGESTION_MAX_REVIEWS`, las más recientes):
   si hay menos de `REVIEW_SUMMARY_MIN_REVIEWS` (env, defecto 3) se borra
   la fila y se devuelve `null` (criterio de aceptación); si no, prompt
   versionado `docs/rag/prompts/review-summary.v1.md` + reseñas delimitadas
   como dato no confiable → `generateJson` con esquema
   `{ pros ≤8×140, cons ≤8×140, basedOnCount }`. `basedOnCount` se
   sobrescribe siempre con el conteo real (nunca se confía en el modelo).
   Fallo de esquema tras el reintento → se conserva el resumen previo;
   fallo de proveedor → se conserva el previo (rate-limit propaga 429).
   La regeneración corre inline tras cada cambio que toca `PUBLISHED`
   (el método es el punto único al que un futuro job BullMQ llamaría).
6. **Prompt injection.** Las reseñas viajan delimitadas y marcadas como
   no confiables; el esquema Zod (cadenas cortas, máx. 8) impide que texto
   inyectado altere la forma; el resumen solo parafrasea (nunca citas
   largas ni datos del autor).

## Alternativas consideradas

- Resumen al vuelo en cada lectura: rechazado — costaría una llamada LLM
  por vista de producto; la caché con regeneración en la moderación es la
  opción más simple y acotada.
- Job BullMQ dedicado con cola propia: rechazado por ahora — el refresh
  inline es síncrono y barato (≤20 reseñas); el método único permite
  moverlo a una cola sin cambiar el contrato cuando el volumen lo pida.
- `GET summary → 404` bajo el mínimo: rechazado — el frontend distingue
  "sin resumen aún" (200 + null) de "producto inexistente" (404).

## Variables

- `REVIEW_SUMMARY_MIN_REVIEWS` (defecto 3): mínimo de publicadas para generar.
- `REVIEW_INGESTION_MAX_REVIEWS` (defecto 20): tope de reseñas por documento/resumen.
