# 0042 — Fallback léxico en `GET /search` (marca/nombre/SKU)

Fecha: 2026-10-12
Estado: aceptado

## Contexto

Reporte: buscar "Kingston" en el home devolvía 2 productos sin relación
(Asus ROG Maximus Z890, Seasonic Focus GX-850) en vez de los 4 productos
Kingston ACTIVE del catálogo. Causas verificadas contra la API y la BD:

- El corpus RAG solo cubre 2 de 41 productos ACTIVE (los Kingston no tienen
  ningún chunk: el seed `prisma/seed.ts` no crea documentos `auto:product` y
  `syncProduct` solo corre en altas/modificaciones del admin). El ADR 0022 ya
  documenta que la búsqueda "solo ve productos con chunks".
- La rama vectorial siempre devuelve los K vecinos más cercanos aunque su
  distancia sea enorme. Con `q=Kingston` ambas respuestas traían
  `score ≈ 0.016 (= 1/(60+1))`: hits de una sola rama, sin ningún match
  full-text. Sin umbral de relevancia, esos vecinos se mostraban como si
  hicieran match.
- El filtro `q` del catálogo (`buildProductWhere`) tampoco cubre marca, así
  que ni siquiera la vía SQL exacta encontraba "Kingston".

## Decisión

- `SearchService.search` suma una query léxica Prisma (`contains`,
  `mode: 'insensitive'`, parametrizada, sin SQL crudo) sobre nombre,
  descripción, SKU, marca (nombre/slug) y traducciones (nombre/descripción),
  solo productos ACTIVE, orden determinista por nombre, `take: limit`.
- Si hay matches léxicos, ganan: los vecinos puramente vectoriales se
  descartan (su hidratación SQL se omite para ahorrar una query) y la
  respuesta trae solo matches de catálogo. Score base `LEXICAL_MATCH_SCORE
  = 1` (muy por encima de cualquier RRF ≈ 0.03) más el score RRF cuando el
  producto tiene ambas evidencias; el snippet prefiere el fragmento del chunk
  (citable) y cae al `description` de SQL si no hay chunks.
- Sin matches léxicos, el ranking sigue siendo puramente semántico (sin
  cambios) y los filtros `category`/`maxPrice` se aplican igual en ambas
  ramas. `degraded` y el rate limit no cambian; no hay LLM.
- Tests en `search.service.spec.ts`: mock de `findMany` distingue la llamada
  léxica (`where.OR`) de la hidratación RAG (`where.id.in`); casos nuevos de
  regresión para marca, evidencia combinada, filtros y vacío total.

## Alternativas descartadas

- Umbral mínimo de distancia coseno / exigir consenso de ambas ramas RRF:
  elimina el ruido pero deja a "Kingston" con 0 resultados (sus productos
  siguen sin chunks). No resuelve el reporte.
- Backfill masivo de SPEC_SHEET para los 39 productos sin documento en esta
  misma tarea: es el fix de fondo del corpus, pero implica reindexar con costo
  de embeddings y un job/script propio; se deja como tarea separada.
- Empujar `category`/`maxPrice` como filtros duros de recuperación: el ADR
  0022 ya explica por qué se pierde cobertura (categoría por documento vs.
  por producto); no se toca.

## Consecuencias

- `q=Kingston` devuelve los 4 Kingston (score 1, snippet = descripción) y
  nunca vecinos sin soporte textual cuando el catálogo hace match.
- Consultas sin match léxico ("algo para jugar…") conservan el
  comportamiento semántico anterior.
- Pendiente (no parte de este cambio): backfill de `auto:product` para todos
  los ACTIVE + que el seed los genere, para que el RAG también los "vea".
