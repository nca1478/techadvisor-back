# 0015 — RAG corpus full-text search with per-locale text configuration

Date: 2026-10-08
Status: accepted

## Context

Chunks carry a `locale` (BCP 47, initially `es` and `en`) and the hybrid
retrieval (AGENTS.md §7) needs full-text candidates with correct stemming per
language ("portátil" must find "portátiles", "laptop" must find "laptops").
PostgreSQL text search needs one `regconfig` per language, but each chunk row
has its own locale, so a single static configuration is wrong. Prisma has no
`tsvector` type, so whatever we build must live outside `schema.prisma` and be
queried via `$queryRaw`.

**Note on MCP context7:** it was not available in this environment; the design
uses only built-in PostgreSQL text-search features (`to_tsvector`,
`plainto_tsquery`, GIN), so no version lookup was needed. No new dependency
was installed.

## Decision

- **Locale map (single source of truth):** immutable SQL function
  `rag_regconfig(locale text) returns regconfig` — Spanish locales (`es`,
  `es-*`) map to `spanish`, everything else falls back to `english`
  (matches `SUPPORTED_LOCALES=en,es`; regional variants such as `es-MX` are
  covered by prefix, unknown languages degrade to english rather than failing).
- **`tsv` column owned by raw SQL:** migration
  `..._add_chunk_tsv_fulltext` adds `chunks.tsv tsvector` plus a
  `BEFORE INSERT OR UPDATE OF content, locale` trigger
  (`chunks_tsv_update`) that sets
  `tsv = to_tsvector(rag_regconfig(locale), content)`. A trigger (instead of a
  `GENERATED ALWAYS` column) was chosen so backfills are a plain `UPDATE` and
  the mechanism stays visible next to the function it depends on.
- **Prisma stays out of it:** `tsv` has no counterpart in `schema.prisma`
  (Prisma cannot map `tsvector`); application code reads it only through
  `$queryRaw`, casting `regconfig` to `text` when selected (the Prisma driver
  cannot deserialize `regconfig`).
- **Query contract:** full-text lookups always pair both sides on the same
  config — `tsv @@ plainto_tsquery(rag_regconfig(locale), $query)` — so the
  query is analyzed with the chunk's own language. The hybrid-retrieval
  service (later task) reuses `rag_regconfig`; no per-language query code.
- **Indexes:** GIN on `tsv` (`chunks_tsv_gin_idx`), GIN on `metadata`
  (Prisma `@@index(type: Gin)`), btree on `document_id`, `product_id`,
  `locale`, unique `(document_id, ord)` for idempotent ingestion.
- **No embedding column in this task:** `embedding vector(N)` arrives when the
  default embedding model fixes `N` (task P2.3), with `embedding_model` /
  `embedding_dim` per chunk.

## Consequences

- Inserting/updating a chunk through Prisma transparently maintains `tsv`;
  no application code needed.
- Spanish/english stemming verified by `src/prisma/chunk.fulltext.spec.ts`.
- Adding a language later = one `WHEN` branch in `rag_regconfig` + backfill
  `UPDATE chunks SET tsv = ...` (additive migration), no schema change.
- `pgvector` dimension limit and embedding reindex procedure are out of scope
  here (task P2.3).
