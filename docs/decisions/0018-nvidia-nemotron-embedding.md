# 0018 — NVIDIA `nemotron-3-embed-1b` via native adapter + `halfvec(2048)`

Date: 2026-10-08
Status: accepted

## Context

`nvidia/nemotron-3-embed-1b` (~1.14B params, served on
`https://integrate.api.nvidia.com/v1`) is a strong multilingual embedding
model (34 evaluated languages, incl. Spanish and English) and therefore a
legitimate alternative default under the provider-agnostic design
(AGENTS.md §7, ADRs 0016/0017). But it is NOT a drop-in `openai-compatible`
config, for three verified reasons:

1. **Native dim 2048 > pgvector indexed `vector` cap (2000).**
   The model returns 2048 dims and its NIM `dimensions` parameter only
   accepts *omitted or 2048* (no server-side reduction). It cannot be indexed
   as `vector(2048)`, nor does it fit the current `vector(1536)` column.
2. **The generic adapter always sends `dimensions`** (ADR 0016), which this
   model rejects (400). The parameter must be omitted for NVIDIA.
3. **It needs `input_type`: `query` vs `passage`.** NVIDIA docs warn of large
   accuracy drops when it is wrong or missing. The generic adapter never
   sends it (the `EmbedOptions.kind` hint exists in the interface but is
   ignored by `openai-compatible`).

**Note on MCP context7:** available, but no lookup needed — no new
dependency is installed (plain `fetch` + shared `common/` utils, same as
ADR 0016). Model facts below come from NVIDIA's NIM reference, support
matrix and Hugging Face model card (all stating 2048 dims, 34 languages,
`input_type` requirement).

## Decision

- **Native adapter** `NvidiaEmbeddingAdapter` in `modules/ai/adapters/`
  (AGENTS.md §5.11 explicitly foresees one native adapter per provider with
  own characteristics). It reuses `splitIntoBatches`/`withRetry`/error
  normalization from `common/` and differs from the generic adapter in
  exactly three fields: **no `dimensions`**, **`input_type` from `kind`**
  (`query` → `query`, anything else → `passage`, the safe indexing
  default), **`modality: 'text'`**.
- **New provider id `nvidia`** (`EMBEDDING_PROVIDER=nvidia`,
  `EMBEDDING_MODEL=nvidia/nemotron-3-embed-1b`,
  `EMBEDDING_BASE_URL=https://integrate.api.nvidia.com/v1`,
  `EMBEDDING_API_KEY=nvapi-…`, `EMBEDDING_DIM=2048`). Adding it is one enum
  value + one factory branch; consumers are untouched.
- **Storage: new nullable column `embedding_halfvec halfvec(2048)`** with
  HNSW index (`halfvec_cosine_ops`). Rationale: `halfvec` supports up to
  4000 dims with HNSW (verified on pgvector 0.8.7), keeps the model's
  native fidelity (no truncation/renorm code, ~4 KB/vector instead of
  ~8 KB), and follows the ADR 0017 reindex procedure (new column, old
  `vector(1536)` column kept, never rewritten). The client-side
  slice-to-1024 alternative was rejected: it trades quality for no
  infra gain here and needs renormalization code on every write/read path.
- **`EMBEDDING_DIM` cap raised 2000 → 4000** (the `halfvec` indexed limit),
  with the comment updated: `vector(N≤2000)` vs `halfvec(N≤4000)`. The
  adapter still fails loudly when the response length ≠ `EMBEDDING_DIM`,
  so a misconfigured DIM can never silently pollute a column.
- Retrieval keeps querying the column that matches the configured model;
  query vectors must always come from the same model as the column
  (AGENTS.md §7). The retrieval service (later task) reads
  `chunks.embedding_model` to pick the column.

## Cost estimate

NVIDIA Build serves NIM behind trial credits + pay-as-you-go (exact rate
checked at time of use on build.nvidia.com; no live key is committed or
needed for tests). Token math for comparison with ADR 0017: initial corpus
~400k tokens; per query ~200 tokens. No inference cost can accrue from
this repo's tests — they use a stub `fetch` only.

## Consequences

- `EMBEDDING_PROVIDER=nvidia` without `EMBEDDING_MODEL` set fails fast
  (same rule as `openai-compatible`); `EMBEDDING_DIM` must be 2048 or the
  adapter's length check fails loudly instead of mixing dims.
- `kind: 'query'` must be passed for question/query embeddings; document
  embeddings default to `passage`. Forgetting `kind` on a query degrades
  accuracy silently — the integration spec pins the mapping so regressions
  fail loudly.
- Switching default ↔ NVIDIA later = env change + backfill of the other
  column + eval gate (procedure in ADR 0017); no code changes.
- The pre-existing local `.env` (`PROVIDER=nvidia`, `DIM=1536`) becomes
  schema-valid for the provider but still wrong in DIM: it must be
  `EMBEDDING_DIM=2048` (see report of the implementing task).
