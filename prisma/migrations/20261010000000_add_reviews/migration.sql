-- Customer reviews + cached pros/cons summaries (Fase 6, P6.2; ver
-- docs/decisions/0037-reviews-summaries.md).
--
-- `reviews` holds one row per (product, user): only buyers (order in PAID or
-- DELIVERED containing the product, checked in application code) may insert,
-- enforced here by UNIQUE(product_id, user_id). `rating` bounds (1..5) are a
-- DB CHECK. Only PUBLISHED rows are listed publicly, ingested as REVIEW
-- documents and fed to the summary.
-- `product_review_summaries` caches one LLM-generated pros/cons row per
-- product (PK/FK product_id); absent while published reviews are below
-- REVIEW_SUMMARY_MIN_REVIEWS. Everything here is additive and idempotent
-- (IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewStatus') THEN
    CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "reviews" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "body" TEXT NOT NULL,
  "verified_purchase" BOOLEAN NOT NULL DEFAULT true,
  "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "reviews_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_product_id_fkey'
  ) THEN
    ALTER TABLE "reviews"
      ADD CONSTRAINT "reviews_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_user_id_fkey'
  ) THEN
    ALTER TABLE "reviews"
      ADD CONSTRAINT "reviews_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_product_id_user_id_key'
  ) THEN
    ALTER TABLE "reviews"
      ADD CONSTRAINT "reviews_product_id_user_id_key"
      UNIQUE ("product_id", "user_id");
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "reviews_product_id_status_idx"
  ON "reviews"("product_id", "status");

CREATE INDEX IF NOT EXISTS "reviews_user_id_idx"
  ON "reviews"("user_id");

CREATE TABLE IF NOT EXISTS "product_review_summaries" (
  "product_id" UUID NOT NULL PRIMARY KEY,
  "pros" JSONB NOT NULL DEFAULT '[]',
  "cons" JSONB NOT NULL DEFAULT '[]',
  "based_on_count" INTEGER NOT NULL,
  "model" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_review_summaries_product_id_fkey'
  ) THEN
    ALTER TABLE "product_review_summaries"
      ADD CONSTRAINT "product_review_summaries_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;
  END IF;
END
$$;
