-- Embedding storage for the default model (see
-- docs/decisions/0017-default-embedding-model.md).
--
-- `embedding vector(1536)` is owned ENTIRELY by this raw SQL migration:
-- Prisma has no vector type, so the column intentionally has no counterpart
-- in schema.prisma and must only be written/read via `$queryRaw`.
-- `embedding_model`/`embedding_dim` ARE Prisma model fields (Chunk model);
-- they are created here (instead of a generated migration) so the vector
-- column, its metadata and its index land atomically in one additive step.
-- Everything here is additive and idempotent (IF NOT EXISTS).

-- 1536 = native output of text-embedding-3-small (ADR 0017). NULLABLE:
-- pre-embedding chunks stay queryable by full text while backfill runs;
-- vector retrieval filters `embedding IS NOT NULL`.
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT;
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding_dim" INTEGER;

-- HNSW index for cosine-similarity nearest-neighbor lookups
-- (`ORDER BY embedding <=> $query LIMIT $k`). Cosine (`vector_cosine_ops`)
-- matches direction-semantic text embeddings (see ADR 0017).
CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx"
  ON "chunks" USING hnsw ("embedding" vector_cosine_ops);
