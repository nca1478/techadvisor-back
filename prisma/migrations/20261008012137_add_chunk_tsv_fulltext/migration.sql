-- Full-text search over chunks.content with a per-locale text-search
-- configuration (see docs/decisions/0015-rag-corpus-fulltext-per-locale.md).
--
-- Prisma owns the tables, but the `tsv` column is owned ENTIRELY by this raw
-- SQL migration: Prisma has no tsvector type, so `tsv` intentionally has no
-- counterpart in schema.prisma and must only be read via `$queryRaw`.
-- Everything here is additive and idempotent (IF NOT EXISTS / OR REPLACE).

-- Maps a BCP 47 chunk locale to a PostgreSQL text-search configuration:
-- Spanish locales (`es`, `es-*`) -> spanish, anything else -> english.
-- IMMUTABLE so query planners can inline it; deterministic by design.
CREATE OR REPLACE FUNCTION rag_regconfig(p_locale text)
RETURNS regconfig
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN lower(p_locale) LIKE 'es%' THEN 'spanish'::regconfig
    ELSE 'english'::regconfig
  END
$$;

-- Adds the tsvector column kept in sync with content/locale on every write.
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

-- Backfills rows written before the trigger existed (no-op on fresh DBs).
UPDATE "chunks"
SET tsv = to_tsvector(rag_regconfig(locale), COALESCE(content, ''))
WHERE tsv IS NULL;

-- GIN index for `tsv @@ query` lookups.
CREATE INDEX IF NOT EXISTS "chunks_tsv_gin_idx" ON "chunks" USING GIN ("tsv");
