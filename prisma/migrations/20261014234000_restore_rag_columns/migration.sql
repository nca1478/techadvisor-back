-- Restores the raw-SQL-owned RAG columns dropped by
-- 20261014005223_add_another_migration (see docs/decisions/0048
-- addendum below).
--
-- Root cause: `tsv`, `embedding`, `embedding_halfvec` and `embedding_v2`
-- are owned ENTIRELY by raw SQL migrations (Prisma has no tsvector/vector/
-- halfvec types, so they intentionally have no counterpart in
-- schema.prisma). An auto-generated `prisma migrate dev` drift migration
-- saw them as "extra" columns and dropped them, breaking every chunk write
-- (the `chunks_tsv_update` trigger references `NEW.tsv`) and all RAG
-- ingestion/seed scripts. Lesson: never accept a generated migration that
-- drops these columns; Prisma must not manage them.
--
-- This repair is strictly additive and idempotent (IF NOT EXISTS /
-- OR REPLACE), so it is a no-op on databases where the columns still exist.
-- It re-applies the exact definitions of 20261008012137 (tsv),
-- 20261008013000 (embedding vector(1536)), 20261008014000
-- (embedding_halfvec halfvec(2048)) and 20261008121000 (embedding_v2
-- vector(16)).

-- Full-text column + per-locale trigger + GIN index (from 20261008012137).
CREATE OR REPLACE FUNCTION rag_regconfig(p_locale text)
RETURNS regconfig
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN lower(p_locale) LIKE 'es%' THEN 'spanish'::regconfig
    ELSE 'english'::regconfig
  END
$$;

ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "tsv" tsvector;

CREATE OR REPLACE FUNCTION chunks_tsv_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.tsv := to_tsvector(rag_regconfig(NEW.locale), COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chunks_tsv_update ON "chunks";
CREATE TRIGGER chunks_tsv_update
  BEFORE INSERT OR UPDATE OF content, locale ON "chunks"
  FOR EACH ROW EXECUTE FUNCTION chunks_tsv_trigger();

UPDATE "chunks"
SET tsv = to_tsvector(rag_regconfig(locale), COALESCE(content, ''))
WHERE tsv IS NULL;

CREATE INDEX IF NOT EXISTS "chunks_tsv_gin_idx" ON "chunks" USING GIN ("tsv");

-- Default-model vectors (from 20261008013000).
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx"
  ON "chunks" USING hnsw ("embedding" vector_cosine_ops);

-- NVIDIA 2048-dim halfvec storage (from 20261008014000).
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding_halfvec" halfvec(2048);
CREATE INDEX IF NOT EXISTS "chunks_embedding_halfvec_hnsw_idx"
  ON "chunks" USING hnsw ("embedding_halfvec" halfvec_cosine_ops);

-- Reindex landing column (from 20261008121000).
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embedding_v2" vector(16);
CREATE INDEX IF NOT EXISTS "chunks_embedding_v2_hnsw_idx"
  ON "chunks" USING hnsw ("embedding_v2" vector_cosine_ops);
