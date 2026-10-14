# 0049 — Columnas RAG declaradas como `Unsupported`: `migrate dev` sin drift

Fecha: 2026-10-14
Estado: aceptado

## Contexto

Tras el incidente del addendum del ADR 0048 (una migración de drift
autogenerada eliminó `tsv`, `embedding`, `embedding_halfvec` y
`embedding_v2`), la cadena se reparó borrando la migración duplicada sin
commitear (`20261014041450`) y restaurando las columnas
(`20261014234000`). Pero `npm run db:migrate` (`prisma migrate dev`)
seguía sin ejecutarse limpio: al terminar de aplicar las migraciones pedía
`Enter a name for the new migration`, porque la fase final de `migrate dev`
compara la BD contra `schema.prisma` y veía esas 4 columnas + sus 4 índices
como "sobrantes" (no tenían contraparte en el schema). Aceptar ese prompt
es exactamente lo que generó las migraciones destructivas en el pasado.

## Decisión

- Declarar las 4 columnas en el modelo `Chunk` como `Unsupported`
  (`tsv`, `embedding`, `embeddingHalfvec`, `embeddingV2` con sus `@map`), y
  sus 4 índices reales con `map:` (`chunks_tsv_gin_idx` con `type: Gin`; los
  3 HNSW como `@@index` con nombre mapeado, que es como la propia
  introspección de Prisma los representa). Verificado: `migrate diff`
  BD-vs-schema ahora devuelve una migración vacía.
- Propiedad inalterada: DDL, trigger `chunks_tsv_update`, índices y todas
  las lecturas/escrituras siguen en migraciones SQL manuales y `$queryRaw`.
  Los campos `Unsupported` son invisibles para Prisma Client (solo marcan el
  drift); está prohibido consultarlos vía cliente tipado y prohibido que una
  migración generada los gestione.
- Regla de flujo: ante el prompt de `migrate dev` para crear una migración,
  revisar siempre el diff; si incluye `DROP` de columnas RAG, abortar.

## Consecuencias

- `npm run db:migrate` termina con `Already in sync, no schema change or
  pending migration was found`, sin prompt y repetible; `migrate status`
  queda `up to date`.
- `npx prisma db pull` ya no propondría cambios en `Chunk` (las
  declaraciones coinciden con su representación).
- Si un futuro modelo de embeddings añade otra columna física, hay que
  declararla igual (`Unsupported` + índice con `map:`) en la misma tarea que
  introduzca su migración SQL.
- Alternativa descartada: cambiar `db:migrate` a `migrate deploy` (evita el
  prompt al aplicar, pero no elimina la causa: cualquier `migrate dev`
  futuro para un cambio de schema volvería a mezclar los `DROP` en la
  migración generada).
