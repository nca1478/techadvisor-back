# ADR 0022 — Búsqueda semántica pública (`GET /search`)

Fecha: 2026-10-07 · Estado: aceptado

## Contexto

P2.7 expone la recuperación híbrida (ADR 0021) como búsqueda en lenguaje
natural sobre el catálogo, visible para el cliente. Requisitos: agrupar
chunks por producto con precio/stock/imagen desde SQL (nunca de chunks),
rate limiting, degradación si el proveedor de embeddings falla, y sin LLM.

## Decisión

- **Endpoint** `GET /api/v1/search?q=&category=&maxPrice=&currency=&locale=&limit=`
  en el módulo `search` (controlador delgado, lógica en `SearchService`).
- **`q` máx. 200 caracteres** (la recuperación acepta 1000): las cajas de
  búsqueda envían consultas cortas; el tope acota el costo de embeddings y
  el trabajo full-text por request.
- **Recuperación**: `RetrievalService.search` con `topN: 30` (varios chunks
  por producto), luego agrupación por `productId` (score = mejor chunk,
  snippet = su contenido truncado a 280 caracteres). Chunks sin producto
  (categoría/política) no generan tarjeta y se omiten.
- **Filtros**: `category` (slug) y `maxPrice` (unidades menores en la moneda
  pedida, precio resuelto según ADR 0007) se aplican **después** de hidratar
  desde SQL. No se empujan como filtros duros a la recuperación porque el
  filtro de categoría de recuperación mira `documents.category_id` y
  perdería los chunks SPEC_SHEET asociados por producto.
- **Rate limiting**: throttler nombrado `search` (60 req/min por IP,
  `SEARCH_RATE_LIMIT_MAX/_TTL_MS`); el controlador lo usa con
  `@SkipThrottle({ auth: true })` para no sumar el tope de auth. Hay un solo
  `ThrottlerModule.forRoot` (en `AuthModule`); el guard aplica todos los
  throttlers salvo los omitidos, verificado en el código del guard.
- **Degradado**: si `embed()` falla con `AiProviderError`, se reintenta con
  `RetrievalService.searchFulltextOnly` (mismo corpus y filtros duros, solo
  rama `ts_rank`, puntuado en la misma escala RRF) y la respuesta lleva
  `degraded: true`. Otros errores se propagan.
- **Sin LLM** en esta tarea; la respuesta es
  `{ query, degraded, locale, currency, results: [{ product, score, snippet }] }`.

## Consecuencias

- El frontend usa el mismo endpoint para sugerencias (`limit=5`) y para la
  página `/buscar` (`limit=12` por defecto, máx. 24).
- Cambiar el tope de `q`, `topN` o el rate limit es solo configuración o
  constante documentada aquí; no cambia el contrato.
- La búsqueda solo "ve" productos con chunks indexados (SPEC_SHEET auto por
  producto desde P2.4); un producto ACTIVE sin chunks no aparece.

## Cómo revertir

Eliminar `SearchModule` de `AppModule` y el throttler `search` de
`AuthModule`; `searchFulltextOnly` queda como API pública de recuperación
sin uso hasta el asesor (Fase 3).
