-- Additive: Google sign-in (see ADR 0077). New AuthProvider enum + users.provider
-- (default LOCAL so existing rows stay local); password_hash becomes nullable
-- so Google-created users exist without a local password. No drops/renames.
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE');

ALTER TABLE "users" ADD COLUMN "provider" "AuthProvider" NOT NULL DEFAULT 'LOCAL';

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
