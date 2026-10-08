-- Provenance of RAG source documents (see docs/decisions/0019-ingestion-pipeline.md).
--
-- `source` distinguishes admin-registered documents (`manual`, the default
-- for all pre-existing rows) from the SPEC_SHEET auto-generated from a
-- product row (`auto:product`). The partial-scope unique index guarantees
-- one auto-generated document per product: PostgreSQL treats NULL
-- `product_id` values as distinct, so manual documents without a product
-- keep working untouched.
-- Everything here is additive and idempotent (IF NOT EXISTS).

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';

-- Backfill guard: rows created before this column existed already carry the
-- DEFAULT above; the UPDATE below only matters for exotic paths that wrote
-- NULL explicitly (the column is NOT NULL, so this is a no-op in practice).
UPDATE "documents" SET "source" = 'manual' WHERE "source" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'documents_product_id_source_key'
  ) THEN
    CREATE UNIQUE INDEX "documents_product_id_source_key" ON "documents"("product_id", "source");
  END IF;
END
$$;
