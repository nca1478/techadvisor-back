# 0017 — Default embedding model: `text-embedding-3-small` (1536 dims)

Date: 2026-10-08
Status: accepted

## Context

Task P2.3 fixes the initial default embedding model and the dimension `N` of
`chunks.embedding vector(N)`. Requirements (AGENTS.md §7, ADRs 0015/0016):

- Multilingual retrieval, at minimum Spanish and English (`SUPPORTED_LOCALES=en,es`).
- Storage stays on pgvector in the same PostgreSQL (no external vector DB).
- The model must remain swappable by configuration (`EmbeddingProvider` +
  `AiProviderFactory`); the column fixes one `N`, and every chunk records
  `embedding_model`/`embedding_dim` so models are never mixed in one column.
- pgvector caps indexed `vector(N)` at 2.000 dimensions: a model above that
  needs server-side dimension reduction or `halfvec` before it can be indexed.

**Note on MCP context7:** it was available in this environment, but no lookup
was needed — no new dependency was installed. The choice below is consumed
through the existing `openai-compatible` adapter (plain `fetch`, ADR 0016)
and the pgvector image already pinned in `docker-compose.yml`
(`pgvector/pgvector:pg16`, extension 0.8.7 verified locally). No new package,
so there was nothing to version-check.

## Decision

- **Default model:** `text-embedding-3-small` (OpenAI).
- **Default provider path:** `EMBEDDING_PROVIDER=openai-compatible` with
  `EMBEDDING_BASE_URL=https://api.openai.com/v1` (any OpenAI-compatible
  endpoint serving this model — OpenRouter, self-hosted gateways, … — works
  unchanged; only env values change).
- **Dimension:** `N = 1536` (the model's native output, no truncation).
  `EMBEDDING_DIM=1536`, column `chunks.embedding vector(1536)`.
- **Why this model:**
  - Multilingual: one model covers English and Spanish (plus other major
    European languages), so `es`/`en` chunks and queries share a single
    vector space — no per-language columns or models.
  - Native 1536 dims fit the pgvector indexed limit (≤ 2000): **no
    reduction and no `halfvec` needed**. (If a future model exceeds 2000,
    apply its Matryoshka/`dimensions` parameter first — e.g.
    `text-embedding-3-large` truncated to 1024 — and record the procedure
    in a new ADR; the reindex procedure below already covers the migration.)
  - Cheap and fast: $0.02 per 1M input tokens (OpenAI standard rate, 2026),
    8192 max input tokens per request, ~50–200 ms latency. The 3-small
    Matryoshka support (`dimensions` param, already forwarded by our
    adapter per ADR 0016) leaves the door open to shrink later.
- **Why not the alternatives (for now):**
  - `text-embedding-3-large` (3072 dims): exceeds the 2000 indexed cap, so
    it would force truncation from day one for +~2 MTEB points at 6.5× the
    price ($0.13/MTok). Revisit via the switch procedure if retrieval
    quality demands it.
  - `text-embedding-ada-002` (1536 dims): legacy, superseded by 3-small on
    quality (62.3 vs 61.0 MTEB avg, vendor-reported) at 5× the price
    ($0.10/MTok). No reason to default to it.
  - Self-hosted multilingual models (e.g. E5/BGE via Ollama/vLLM): viable
    later through the same `openai-compatible` adapter with zero code
    changes; rejected as the *default* only because they add an ops burden
    (GPU/hosting) this phase does not need.
- **Distance operator:** cosine (`vector_cosine_ops`). Embeddings are
  direction-semantic (our fake adapter even L2-normalizes); cosine distance
  (`<=>`) is the standard for text similarity and matches the retrieval
  design (RRF over vector + full-text candidates).
- **Index:** `HNSW` on `embedding` (`chunks_embedding_hnsw_idx`), default
  parameters (`m=16`, `ef_construction=64`) — right for a corpus that starts
  in the thousands of chunks. Tune (`m`, `ef_construction`, `ef_search`)
  with measured recall when the corpus grows; that tuning gets its own ADR.
- **Nullability:** `embedding` starts NULLABLE. Pre-embedding chunks (the
  full-text-only rows from earlier tasks) stay queryable by text while
  backfill runs; retrieval filters `embedding IS NOT NULL` for vector
  candidates. `embedding_model`/`embedding_dim` are likewise nullable until
  a chunk is embedded.

## Cost estimate (initial corpus)

Billing is input-only: `total_tokens / 1M × $0.02`.

| Item | Assumption | Tokens | Cost (USD) |
|---|---|---|---|
| Initial ingest (~120 docs × ~8 chunks × ~400 tokens) | seed catalog + policies/FAQs/manuals | ~400k | ~$0.008 |
| Full reindex (worst case = ingest again) | same corpus | ~400k | ~$0.008 |
| Per advisor query (query embedding only) | ~200 tokens | 200 | ~$0.000004 |

Even a 10× larger corpus (~4M tokens) costs under $0.10 to (re)index.
Storage per vector: 1536 × 4 bytes ≈ 6 KB (+HNSW overhead); 10k chunks ≈
~60–100 MB. Negligible at this scale.

## Switching models (reindex procedure, non-destructive)

Concrete application of AGENTS.md §7 to this repo. Never rewrite
`chunks.embedding` in place; never mix models/dims in one indexed column.

1. Pick the new model; if its dim `M ≠ 1536`, add a column
   `embedding_v2 vector(M)` (+ HNSW index) in an **additive** migration.
   If `M > 2000`, first reduce via the provider's `dimensions` parameter
   (or `halfvec`) and ADR the choice.
2. Set the new `EMBEDDING_MODEL`/`EMBEDDING_DIM` in env; the background
   reindex job (ingestion phase) recomputes every chunk idempotently
   (`content_hash` unchanged → recompute embedding only) writing the new
   column plus `embedding_model`/`embedding_dim` per chunk. Resumable:
   chunks already carrying the new `embedding_model` are skipped.
3. During reindex, retrieval keeps querying the old column with query
   vectors from the old model (query and column models must always match).
4. Flip retrieval to the new column only when reindex is complete and the
   eval recall gate (`npm run eval`, Fase 7) passes.
5. Drop the old column/index later, in a separate migration + ADR.

Swapping providers/models that keep `N = 1536` needs no schema change at
all: env change + reindex into the same column (after draining or
versioning rows by `embedding_model`).

## Rules that stay in force

- Every embedded chunk persists `embedding_model` (adapter's `model`) and
  `embedding_dim` (adapter's `dimensions`).
- `EMBEDDING_DIM` must equal the indexed column width; the adapter already
  fails loudly on length mismatch (ADR 0016).
- `PROVIDER=fake` is dev/test-only and labels vectors `fake-hash-v1`
  (keep `EMBEDDING_MODEL` empty with `fake`); never persist fake vectors
  under the production model name.
- No live embedding calls in tests: offline `FakeEmbeddingAdapter` only
  (`src/prisma/chunk.embedding.spec.ts` proves cosine ordering + HNSW use).

## Consequences

- Migration `..._add_chunk_embedding_vector` adds `embedding vector(1536)`
  (raw SQL, like `tsv` — Prisma has no vector type) plus Prisma-mapped
  `embedding_model`/`embedding_dim`, and the HNSW cosine index.
- `.env.example` records the default (`MODEL=text-embedding-3-small`,
  `DIM=1536`, OpenAI base URL); schema default `PROVIDER=fake` is unchanged
  so the app still boots offline.
- `EXPLAIN` verification of HNSW use lives in the new integration spec
  (planner needs `enable_seqscan=off` on tiny fixture tables to prefer the
  index; production-scale tables use it naturally for `ORDER BY … LIMIT`).
