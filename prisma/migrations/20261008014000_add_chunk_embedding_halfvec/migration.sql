-- NVIDIA nemotron-3-embed-1b storage (see
-- docs/decisions/0018-nvidia-nemotron-embedding.md).
--
-- The model's native 2048 dims exceed the pgvector indexed `vector` cap
-- (2000), so it is stored as `halfvec(2048)` (HNSW-capable up to 4000 dims,
-- ~4 KB/vector) instead of truncating fidelity. Like `embedding` and `tsv`,
-- this column is owned ENTIRELY by raw SQL: Prisma has no halfvec type, so
-- it has no counterpart in schema.prisma and is written/read via `$queryRaw`.
-- Per-chunk `embedding_model`/`embedding_dim` (Prisma fields) tell retrieval
-- which column to query. Everything here is additive and idempotent
-- (IF NOT EXISTS); the default-model `vector(1536)` column is kept.

ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding_halfvec" halfvec(2048);

-- HNSW index for cosine-similarity nearest-neighbor lookups
-- (`ORDER BY embedding_halfvec <=> $query LIMIT $k`).
CREATE INDEX IF NOT EXISTS "chunks_embedding_halfvec_hnsw_idx"
  ON "chunks" USING hnsw ("embedding_halfvec" halfvec_cosine_ops);
