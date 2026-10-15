-- Adds the single cover image + home visibility flag to categories.
-- Strictly additive (see ADR 0052): nullable image columns so existing rows
-- keep working, `show_in_home` defaults to TRUE so the home "shop by
-- category" section keeps showing every category until an admin hides one.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "image_url" VARCHAR(2048);
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "image_alt" VARCHAR(200);
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "show_in_home" BOOLEAN NOT NULL DEFAULT TRUE;
