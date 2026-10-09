-- Advisor feedback (Fase 3, P3.3): thumbs up/down on product-QA answers.
--
-- One append-only row per vote from the "Pregúntale al asesor" widget, so a
-- later phase can surface satisfaction in the admin panel. Application code
-- only INSERTs (never UPDATEs or DELETEs). `product_id` is optional with
-- SET NULL like `unanswered_queries`, so deleting a product never fails.
-- Everything here is additive and idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "advisor_feedback" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id" UUID,
  "query" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "abstained" BOOLEAN NOT NULL DEFAULT false,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE "advisor_feedback"
  ADD CONSTRAINT "advisor_feedback_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "advisor_feedback_product_id_idx"
  ON "advisor_feedback"("product_id");

CREATE INDEX IF NOT EXISTS "advisor_feedback_created_at_idx"
  ON "advisor_feedback"("created_at");
