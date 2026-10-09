-- Product-QA abstentions (see docs/decisions/0025-advisor-product-qa.md).
--
-- One row per question the advisor could not answer from retrieved evidence,
-- so the admin panel (Fase 7) can review gaps in the corpus. Append-only:
-- application code only INSERTs (never UPDATEs or DELETEs).
-- Everything here is additive and idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "unanswered_queries" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "query" TEXT NOT NULL,
  "product_id" UUID,
  "session_id" UUID,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE "unanswered_queries"
  ADD CONSTRAINT "unanswered_queries_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "unanswered_queries_product_id_idx"
  ON "unanswered_queries"("product_id");

CREATE INDEX IF NOT EXISTS "unanswered_queries_created_at_idx"
  ON "unanswered_queries"("created_at");
