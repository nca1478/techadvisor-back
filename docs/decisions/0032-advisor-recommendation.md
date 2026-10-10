# ADR 0032 — Recomendación con productos reales (RecommendService)

Fecha: 2026-10-10 · Estado: aceptado

## Contexto

La Fase 4 necesita el flujo completo de recomendación: mensaje del usuario →
`IntentService` (ADR 0031) → conjunto cerrado de candidatos desde SQL →
evidencia de `RetrievalService` → redacción del LLM vía `LlmProvider` →
validación posterior. Restricciones de AGENTS.md §5 aplicables: el LLM nunca
decide precio/stock/disponibilidad (aquí: ni siquiera elige productos fuera
del conjunto SQL), citas validadas, sin SDKs fuera de `adapters/`, sin datos
personales al LLM, todo aditivo (sin migraciones: se reutilizan las tablas
existentes vía `$queryRaw` y los servicios existentes).

## Decisión

- **Ruta**: `POST /advisor/sessions/:id/messages` acepta dos formas sin
  romper el contrato P4.1: con `role` → anexado crudo de historial (201,
  sin cambios); sin `role`, con `content` (+ `locale`/`currency` opcionales)
  → flujo de recomendación (200 JSON, o SSE con
  `Accept: text/event-stream`). La recomendación persiste los turnos USER +
  ASSISTANT en la misma sesión, así el historial sigue coherente.
- **Puerta de aclaración**: si el intent no trae categoría conocida o ningún
  presupuesto (`maxPrice`/`minPrice`), se responde con UNA pregunta de
  aclaración (`buildClarificationQuestion`, prioridad budget → use →
  category) sin consultar SQL ni llamar al LLM de redacción. `use`/`brand`/
  `specs` ausentes no bloquean: solo estrechan menos filtros.
- **Candidatos (SQL, máx. 8)**: un único `$queryRaw` con parámetros ligados
  (nunca interpolación) sobre `products` + `categories` + `brands` +
  `product_prices` + `inventory`:
  - `status = 'ACTIVE'` y `COALESCE(stock - reserved, 0) > 0` (agotados y
    archivados/borradores quedan fuera por construcción).
  - Categoría por `slug`; marcas include/exclude por nombre insensible a
    mayúsculas; precio efectivo en la moneda de la sesión =
    `COALESCE(override_en_moneda, precio_base)` exigiendo precio en esa
    moneda (igual que `buildProductWhere`: sin precio en la moneda, fuera);
    `specs`: igualdad insensible a mayúsculas para texto, igualdad para
    booleanos, `>=` con guarda numérica para números (p. ej. `ram_gb: 16`
    = mínimo 16 GB).
  - Moneda de la sesión = `currency` del request, o la del `maxPrice`
    (si no, la del `minPrice`) del intent, o `BASE_CURRENCY` (siempre
    soportada). Cada cota se aplica SOLO si está expresada en la moneda de
    la sesión; una cota en otra moneda se ignora y se registra (sin
    conversión: no hay tipos de cambio en el sistema).
- **Puntuación determinista**: `score = brandBonus + priceBonus`, donde
  `brandBonus = 50` si la marca está en `brandsInclude` (0 si no) y
  `priceBonus = ROUND(100 * (maxPrice - precio) / maxPrice)` cuando hay tope
  (0 sin tope o si el precio lo iguala). Orden: `score DESC, precio ASC,
  id ASC`, `LIMIT 8`. Todos los candidatos ya cumplen las specs requeridas;
  el score solo ordena (marca preferida, mejor valor dentro del presupuesto).
- **Evidencia**: una sola búsqueda híbrida (`topN = 30`) con la pregunta +
  casos de uso; se conservan los hits cuyo `productId` está en el conjunto
  más los hits sin producto (políticas/categoría). Si el proveedor de
  embeddings falla, se degrada a `searchFulltextOnly`; si también falla, se
  redacta solo con la lista de candidatos (las citas quedan vacías, nunca
  inventadas).
- **Redacción**: `generateJson` (JSON + Zod + UN reintento) con
  `docs/rag/prompts/recommend.v1.md`. El prompt NO recibe precios ni stock,
  y prohíbe cifras en el texto: nombre/precio/stock/imagen se hidratan desde
  SQL en la respuesta. Sin datos personales (solo pregunta, lista y chunks).
- **Validación posterior**: todo `productId` de `items` debe estar en el
  conjunto; los inválidos se descartan y se regenera UNA vez indicando los
  ids permitidos. Si persiste (o `items` queda vacío habiendo candidatos),
  **fallback determinista**: mensaje plantilla es/en con la lista ordenada
  por score (specs desde SQL, sin redacción del LLM) y citas al primer chunk
  de evidencia por producto.
- **Sin candidatos**: pista determinista acotada (≤ 3 consultas): precio
  mínimo efectivo entre los que cumplen el resto de filtros → sugerir subir
  el presupuesto a ese valor; si ni eso existe, conteos quitando specs y
  luego categoría para decir qué relajar. Se registra en
  `unanswered_queries` (`reason: 'no_candidates'`, `productId: NULL`).
- **SSE**: el endpoint con `Accept: text/event-stream` reenvía por eventos
  el texto YA validado (`event: delta` en trozos), luego
  `event: products` con las tarjetas hidratadas y validadas, y cierra con
  `event: done`. Un solo LLM call y productos consistentes con el texto
  (no token-streaming crudo, que impediría validar antes de emitir).
- **Errores de proveedor**: `AiProviderError` → 503, `AiRateLimitError` →
  429 (igual que ADR 0026); `LlmJsonError` en extracción de intent →
  pregunta de aclaración genérica (presupuesto) sin inventar datos.

## Consecuencias

- "portátil para estudiar ingeniería, máx. 800 USD" (y su equivalente en
  inglés) devuelve solo ACTIVE + en stock + ≤ 800 USD con justificación de
  specs, porque el filtro es SQL y el LLM solo redacta.
- Ninguna cifra de precio/stock sale del texto del LLM: el prompt no las
  recibe y la UI las toma de los campos hidratados.
- Cambiar de modelo/proveedor sigue siendo solo configuración.

## Cómo revertir

Quitar la rama `recommend` del controlador y `RecommendService` del módulo;
la ruta vuelve al anexado crudo P4.1. El prompt `recommend.v1.md` queda como
documento huérfano válido (sin borrado en la misma tarea).
