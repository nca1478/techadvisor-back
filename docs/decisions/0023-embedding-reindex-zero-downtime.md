# 0023 — Zero-downtime embedding model switching (reindex pipeline)

Date: 2026-10-08
Status: accepted

## Context

AGENTS.md §7 requires switching embedding models without downtime or data
loss: never rewrite the indexed column in place, never mix models or
dimensions in one column, keep serving the old model during the reindex,
and flip only when the reindex is complete and verified. ADRs 0017/0018
fixed the first two widths (`embedding vector(1536)`, `embedding_halfvec
halfvec(2048)`) but provided no machinery to move between them. This ADR
records that machinery.

**Note on MCP context7:** no new dependency was installed (BullMQ/ioredis
reuse from ADR 0019), so there was nothing to version-check.

## Decision

### Persisted active-model pointer (`rag_embedding_state`, one row)

Retrieval never reads `EMBEDDING_*` directly for model selection. It asks
`EmbeddingStateService.getScope()`, which returns `{ model, dim, column,
cast, embed }` from the single `rag_embedding_state` row (`key =
'active'`). The row is lazy-seeded from env on first use, so fresh
databases behave exactly like the env-configured model with no manual
step. Query embeddings are built from current env credentials plus the
active model/dim via `AiProviderFactory` (same endpoint generally serves
both model ids during a switch) and cached per `model:dim`.

### Reindex jobs (`reindex_jobs` + `reindex` BullMQ queue)

- `POST /admin/reindex` (ADMIN-only) reads the NEW model from
  `EMBEDDING_MODEL`/`EMBEDDING_DIM`, resolves its column through the
  shared registry (`modules/reindex/embedding-columns.ts`), verifies the
  column exists (otherwise 422 with the exact migration SQL to apply —
  columns are never created by implicit runtime DDL), snapshots every
  chunk id, and enqueues one job per batch (`EMBEDDING_BATCH_SIZE` ids
  each, deterministic `jobId = reindex-{job}-{index}` so a batch is never
  queued twice (BullMQ rejects custom ids containing `:`, hence `-`).
  Starting twice for the same target rejoins the RUNNING
  job; a different target while one runs is 409.
- Batches (`ReindexService.processBatch`, also the BullMQ processor body)
  embed only chunks still missing a vector in the target column and write
  ONLY that column. `embedding_model`/`embedding_dim` and the old column
  stay untouched, so retrieval serves the old model with zero degradation
  until activation. Skips (already-vectored chunks, rows deleted after the
  snapshot) count as processed; per-chunk write failures are counted and do
  not abort the batch; a wholesale provider failure propagates so BullMQ
  retries with the shared ingestion backoff (`INGESTION_MAX_ATTEMPTS` /
  `INGESTION_BACKOFF_MS` — a reindex batch is operationally identical to
  an ingestion job, so no new env vars). Counters advance with atomic
  `SET col = col + $n`; COMPLETED flips exactly once via a guarded UPDATE.
- `GET /admin/reindex/jobs/:id` reports snapshot counters (`total`,
  `processed`, `failed`, `percent`) plus the live informational
  `remainingChunks` (chunks missing target vectors — NOT gating, see
  below) and `activatable`.
- `POST /admin/reindex/jobs/:id/resume` re-enqueues batches for every
  chunk still missing a target vector (failed batches, stalled workers).
- `POST /admin/reindex/jobs/:id/activate` flips retrieval, and ONLY when
  the snapshotted set is fully processed with zero failures. The flip is a
  single metadata-only UPDATE retagging the new vectors — scoped to rows
  still carrying the model that was active when the job started
  (`reindex_jobs.source_model`, plus never-tagged rows that received
  vectors), so rows owned by a concurrent writer are never touched — then
  the pointer flip, in that order, so a crash between them is repaired by
  running activation again. The old column is NEVER dropped here.

### Why the gate covers the snapshot, not the live table

`activatable = COMPLETED && failed == 0`. The live `remainingChunks`
figure is reported but advisory: it counts every row missing a target
vector, including transient rows from concurrent writers. Gating on it
would let unrelated activity block (or Tub) a switch; the procedure
instead guarantees coverage because mid-reindex ingestion already writes
new-model vectors (the operator updates env BEFORE starting — step 1
below). Reverting `EMBEDDING_*` mid-reindex is operator error (resume
still surfaces the stragglers).

### Column strategy and the `embedding_v2` landing column

- One width = one typed column + HNSW, resolved by the single registry in
  `embedding-columns.ts` (1536 → `embedding`, 2048 → `embedding_halfvec`,
  16 → `embedding_v2`). Unknown widths throw with the exact DDL template
  (`embeddingColumnDdl`) instead of mixing.
- This task's migration adds `embedding_v2 vector(16)` + HNSW. A future
  production width either reuses a same-`M` slot (no schema change) or
  gets its own column + registry entry via a new additive migration (same
  pattern, plus ADR). Untyped `vector` was rejected for the landing
  column: pgvector 0.8.7 refuses HNSW without dimensions, and cross-width
  distance errors at query time.

### Alternatives rejected

- **In-place rewrite of `embedding`:** violates AGENTS.md §7 (no
  rollback, search degrades mid-rewrite).
- **Runtime `ADD COLUMN` on reindex start:** implicit schema changes are
  unreviewable; the checked migration + 422-with-SQL keeps the DBA in the
  loop with zero extra downtime (the column is provisioned before the
  switch starts).
- **Tag overwrite per batch (`embedding_model` updated by batches):**
  prototyped and discarded — reindexed chunks vanished from old-model
  search mid-reindex. Tags flip once, atomically-ish, at activation.

## Procedure (runbook)

Prerequisite: the target column exists (registry width, or a new additive
migration rendered by `embeddingColumnDdl` and reviewed).

1. Set `EMBEDDING_MODEL` / `EMBEDDING_DIM` to the NEW model and restart
   the API and workers. Retrieval keeps serving the persisted ACTIVE
   (old) model; ingestion starts writing new-model vectors for new
   chunks.
2. `POST /api/v1/admin/reindex` → `{ jobId, totalChunks, batches }`.
   Start `npm run worker:reindex` (or reuse the running one).
3. Poll `GET /api/v1/admin/reindex/jobs/:id` until `status == COMPLETED`,
   `failedChunks == 0` (`activatable: true`). On failures: inspect logs,
   fix the cause (usually provider quota), `POST .../resume`, repeat.
4. Optional: run the eval gate (`npm run eval`, Fase 7) against the new
   vectors before flipping.
5. `POST /api/v1/admin/reindex/jobs/:id/activate` → retrieval serves the
   new model immediately (no restart; every search resolves the scope
   fresh from the state row).
6. Watch search/retrieval metrics; keep the old column for at least one
   release cycle. Dropping it takes a separate migration + ADR.

## Rollback

- **Before activation:** do nothing — the old model is still active and
  its column untouched. Deleting the `reindex_jobs` row only clears
  the dashboard; vectors already written are inert until activated.
- **After activation, new model misbehaves:** reindex back toward the old
  model (its vectors are intact — batches skip everything in one pass and
  activation re-flips the tags), then `activate` the old job. If the old
  column was already dropped (separate later migration), rollback means a
  full re-embed from scratch — which is why the drop waits a cycle.

## Consequences

- New tables `rag_embedding_state`, `reindex_jobs` (+ `ReindexStatus`
  enum); new raw-SQL column `embedding_v2 vector(16)` + HNSW. All additive.
- New module `ReindexModule` (state + service + `reindex` queue +
  `ReindexController` under `/admin/reindex`, ADMIN-guarded like the rest
  of the back office); `RetrievalModule` imports it; new npm script
  `worker:reindex`. No new env vars, no new dependencies.
- `search.e2e-spec.ts` pins the retrieval scope alongside the provider
  override (it already pinned the provider; scope pinning keeps it
  hermetic against the now-global active pointer).
- Tests: registry unit spec; service unit spec (guards, idempotency,
  batching); DB integration spec switching fake-8d → fake-16d end to
  end (search works with both models before/after, old column kept);
  admin-endpoint e2e (auth, validation, already-active path).
