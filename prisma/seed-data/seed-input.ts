import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Shared seed-input schemas and loader.
 *
 * The JSON fixtures in `prisma/seed-data/*.json` are the single source of
 * dev/demo data. Both the `npm run seed` script and the `seed-data.spec.ts`
 * test validate them through these envelopes plus the category `specs`
 * schemas (`parseSpecs`) and `imageUrlSchema`, so `npm test` guards the
 * fixtures without needing a database.
 */

const nonEmptyString = z.string().min(1).max(200);

export const seedCategorySchema = z.strictObject({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, { error: 'category slug must be kebab-case' }),
  name: nonEmptyString,
  /** Spanish translation (DEFAULT_LOCALE content lives in the base columns). */
  nameEs: nonEmptyString,
});

export const seedBrandSchema = z.strictObject({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, { error: 'brand slug must be kebab-case' }),
  name: nonEmptyString,
});

export const seedUserSchema = z.strictObject({
  email: z.email({ error: 'user email must be a valid email address' }),
  password: z.string().min(8, { error: 'seed password must be at least 8 characters' }),
  name: nonEmptyString,
  role: z.enum(['ADMIN', 'CUSTOMER']),
});

/** Spec values are flat scalars today (see `spec-fields.ts`). */
const seedSpecValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const seedProductSchema = z.strictObject({
  /** Business identity: the seed upserts on `sku`, never on the DB id. */
  sku: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, { error: 'product slug must be kebab-case' }),
  /** English text (DEFAULT_LOCALE); Spanish lives in `*Es` (translations). */
  name: z.string().min(1).max(200),
  nameEs: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  descriptionEs: z.string().min(1).max(5000),
  /** Slugs referencing `brands.json` / `categories.json` (resolved by seed). */
  brand: z.string().min(1),
  category: z.string().min(1),
  /** Price in minor units (cents) of BASE_CURRENCY. Never float. */
  priceAmount: z.number().int().positive(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  specs: z.record(z.string(), seedSpecValueSchema),
  /** 1–3 generic https placeholder images (no copyrighted material). */
  images: z.array(z.string().min(1)).min(1).max(3),
  imageAlt: z.string().max(200).optional(),
  stock: z.number().int().min(0),
});

export type SeedCategory = z.output<typeof seedCategorySchema>;
export type SeedBrand = z.output<typeof seedBrandSchema>;
export type SeedUser = z.output<typeof seedUserSchema>;
export type SeedProduct = z.output<typeof seedProductSchema>;

export interface SeedData {
  categories: SeedCategory[];
  brands: SeedBrand[];
  products: SeedProduct[];
  users: SeedUser[];
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return raw;
}

/** Loads and envelope-validates every fixture file (no database access). */
export async function loadSeedData(seedDataDir: string): Promise<SeedData> {
  const [categoriesRaw, brandsRaw, productsRaw, usersRaw] = await Promise.all([
    readJsonFile(join(seedDataDir, 'categories.json')),
    readJsonFile(join(seedDataDir, 'brands.json')),
    readJsonFile(join(seedDataDir, 'products.json')),
    readJsonFile(join(seedDataDir, 'users.json')),
  ]);
  return {
    categories: z.array(seedCategorySchema).parse(categoriesRaw),
    brands: z.array(seedBrandSchema).parse(brandsRaw),
    products: z.array(seedProductSchema).parse(productsRaw),
    users: z.array(seedUserSchema).parse(usersRaw),
  };
}
