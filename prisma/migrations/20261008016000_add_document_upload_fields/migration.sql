-- Admin document uploads (see docs/decisions/0020-document-upload-storage.md).
--
-- WORKFLOW WARNING: this repo owns several columns ENTIRELY in raw SQL
-- (`chunks.tsv`, `chunks.embedding`, `chunks.embedding_halfvec` — Prisma
-- has no tsvector/vector types, so they are invisible in schema.prisma).
-- Never run a bare `npx prisma migrate dev` here: its drift detection
-- proposes DROPPING those columns. Hand-write migrations like this one
-- (additive, idempotent) and apply them with `npx prisma migrate deploy`.
--
-- Adds upload provenance + soft-delete columns to `documents`. Everything
-- here is additive and idempotent (IF NOT EXISTS):
-- - `file_name` / `mime_type` / `size_bytes`: original client metadata kept
--   for display (NULL for pre-existing rows and product auto-documents).
-- - `storage_key`: internal on-disk filename (the document UUID); never
--   exposed via the API, so no index or uniqueness requirement beyond the PK.
-- - `deleted_at`: soft-delete marker. Deletion also removes the document's
--   chunks, so its content stops matching every search immediately; the row
--   itself is kept for audit and list/detail queries filter it out.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "file_name" VARCHAR(255);
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "mime_type" VARCHAR(127);
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "size_bytes" INTEGER;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "storage_key" VARCHAR(255);
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'documents_deleted_at_idx'
  ) THEN
    CREATE INDEX "documents_deleted_at_idx" ON "documents"("deleted_at");
  END IF;
END
$$;
