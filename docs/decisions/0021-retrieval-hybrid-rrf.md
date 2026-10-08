# 0021 — Hybrid retrieval: vector + full-text with RRF

Date: 2026-10-08
Status: accepted

## Context

Task P2.5 needs the retrieval service behind the advisor (AGENTS.md §7):
vector candidates plus full-text candidates, fused with Reciprocal Rank
Fusion, with hard metadata filters and exact SKU/model handling. The building
blocks already exist: `embedding vector(1536)` / `embedding_halfvec(2048)`
with HNSW cosine indexes (ADRs 0017/0018), per-locale `tsv` with the
`rag_regconfig` function and trigger (ADR 0015), and the provider-agnostic
`EmbeddingProvider` (ADR 0016).

**Note on MCP context7:** it was not available in this environment; the
implementation uses only established PostgreSQL features (`<=>` cosine
distance via pgvector, `plainto_tsquery`/`ts_rank`, `regconfig` casts) and
follows the `$queryRaw` patterns already proven in
`src/prisma/chunk.fulltext.spec.ts` and `chunk.embedding.spec.ts`. No new
dependency was installed.

## Decision

- **Module `src/modules/retrieval/`** (`RetrievalModule`, exported
  `RetrievalService`), registered in `AppModule`. Injects only the
  `EMBEDDING_PROVIDER` token — no provider SDK outside `ai/adapters/`.
- **Input validated with Zod** (`retrieval.schemas.ts`): `query` 1–1000
  chars, hard `filters` (`productId`, `categoryId`, `docTypes`, `locales`),
  optional request `locale`, `topN` (default 8, max 50), `candidateK`
  (default 20 per branch), `rrfK` (default 60).
- **Vector branch:** query embedded with `kind: 'query'`; cosine ordering
  (`ORDER BY emb <=> $query LIMIT $k`) against the column matching the
  active width (`1536 → embedding vector`, `2048 → embedding_halfvec`,
  any other width throws — same rule as ingestion, ADR 0019).
- **Full-text branch — one query per linguistic configuration.**
  Each chunk's `tsv` was built with its own locale config (ADR 0015), so the
  query side must use the same config per chunk group. The service resolves
  the configs to query from the request `locale` plus `filters.locales`
  with the same rule as SQL `rag_regconfig` (`es*` → spanish, else english
  — mantener en sync con la migración `..._add_chunk_tsv_fulltext`):
  with no locale information **both** configurations are queried so no
  language group is silently skipped. Each branch restricts with
  `rag_regconfig(c.locale) = config` and ranks with
  `ts_rank(tsv, plainto_tsquery(config, $query))`. This keeps the GIN index
  usable (fixed config per branch) instead of a per-row function mismatch.
- **Strict model scope in both branches:** `c.embedding_model` must equal
  the active provider model. Rationale: the task forbids mixing models in
  one query, and the text branch could otherwise leak foreign-model chunks
  into the fusion. Trade-off (accepted): not-yet-embedded chunks stay out
  of the retrieval service during backfills; raw `tsv` search remains
  available for inspection, and during a model switch retrieval keeps using
  the previous model until reindexing ends (AGENTS.md §7), so the scope is
  always satisfiable.
- **Hard filters in SQL before ranking** (shared fragment, both branches):
  document `READY`, `deleted_at IS NULL`, product `ACTIVE` (chunks without
  a product — category/policy documents — stay visible), plus the optional
  `productId` / `categoryId` / `docTypes` / `locales` filters. All values
  are bound parameters via `Prisma.sql` composition; only the embedding
  column identifier travels via `Prisma.raw`, chosen from an internal
  allowlist, never from user input.
- **SKU/model heuristic** (`sku-pattern.ts`): a token counts as an exact
  identifier when it starts with a letter, has length ≥ 4, contains only
  letters/digits/`-_/…` and contains a digit (`AURORA-X9000`, `RTX4070`).
  When the query carries one, the full-text RRF weight doubles (1 → 2), so
  the exact-match chunk surfaces first. False positives only shift ranking
  weight — they never filter.
- **RRF** (`reciprocal-rank-fusion.ts`, pure function): score
  `Σ weight / (k + rank)` with `k = 60` parametrizable. Consensus across
  modalities wins; per-branch `ts_rank` length quirks stay inside their
  branch because only ranks cross the fusion boundary.
- **No query-text logging** (queries may carry personal data); only
  candidate counts are logged.

## Consequences

- `RetrievalService.search` returns
  `{ chunkId, documentId, productId, content, locale, score, source }`
  with `source = { title, docType, sourceUrl }` — ready for the advisor
  (Fase 3) and the semantic search endpoint.
- Tests: pure unit specs for RRF and the SKU heuristic, a mocked-Prisma
  service spec (model scoping, fusion, validation), and a DB integration
  spec with the fake adapter proving SKU-first ordering, product/docType/
  locale filters, exclusion of non-READY/deleted/archived chunks, and
  no-mixing across embedding models.
- No HTTP surface in this task: endpoints arrive with the advisor/search
  features. No schema change (no migration needed).
