-- Additive: password-reset OTP challenges (see ADR 0078). New table only;
-- no changes to existing tables. Only hashes are stored, never raw codes.
CREATE TABLE "password_resets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "verified_at" TIMESTAMP(3),
  "reset_token_hash" TEXT,
  "reset_token_expires_at" TIMESTAMP(3),
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");
CREATE UNIQUE INDEX "password_resets_reset_token_hash_key" ON "password_resets"("reset_token_hash");

ALTER TABLE "password_resets"
  ADD CONSTRAINT "password_resets_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
