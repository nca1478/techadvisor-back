-- Landing column for the next embedding model width (see
-- docs/decisions/0023-embedding-reindex-zero-downtime.md).
--
-- `embedding_v2 vector(16)` receives the reindexed vectors while retrieval
-- keeps serving the previous model/column with zero downtime. Like the other
-- vector columns (`embedding`, `embedding_halfvec`), it is owned ENTIRELY
-- by this raw SQL migration: Prisma has no vector type, so the column has
-- no counterpart in schema.prisma and is only written/read via `$queryRaw`.
-- The old column is NOT dropped here (that takes a separate migration plus
-- ADR after the switch is verified). Everything here is additive and
-- idempotent (IF NOT EXISTS).

ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding_v2" vector(16);

-- HNSW index for cosine-similarity nearest-neighbor lookups
-- (`ORDER BY embedding_v2 <=> $query LIMIT $k`).
CREATE INDEX IF NOT EXISTS "chunks_embedding_v2_hnsw_idx"
  ON "chunks" USING hnsw ("embedding_v2" vector_cosine_ops);
