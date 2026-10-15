/**
 * Idempotent development/demo seed (`npm run seed` → `tsx prisma/seed.ts`).
 *
 * - Upserts everything on business keys (`slug`/`sku`/email), so running it
 *   twice converges to the same rows instead of duplicating them.
 * - Every product row is validated against the category Zod specs schemas
 *   (`parseSpecs`) and every image against `imageUrlSchema` before touching
 *   the database; the first invalid row aborts the whole run.
 * - Writes only the base price in BASE_CURRENCY (no `product_prices` rows —
 *   see ADR 0007/0014).
 * - Refuses to run with `NODE_ENV=production`. Test users are dev fixtures
 *   documented in the README, never production credentials.
 */
import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { imageUrlSchema, parseSpecs } from '../src/modules/catalog/specs/index.js';
import { loadSeedData, type SeedData, type SeedProduct } from './seed-data/seed-input.js';

const SEED_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'seed-data');
const ES_LOCALE = 'es';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`seed: missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

function validateProductImages(product: SeedProduct): void {
  for (const url of product.images) {
    imageUrlSchema.parse(url);
  }
}

async function seedCategories(prisma: PrismaClient, data: SeedData): Promise<Map<string, string>> {
  const idsBySlug = new Map<string, string>();
  for (const category of data.categories) {
    if (category.imageUrl !== undefined) {
      imageUrlSchema.parse(category.imageUrl);
    }
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        imageUrl: category.imageUrl ?? null,
        imageAlt: category.imageAlt ?? null,
        showInHome: category.showInHome,
      },
      create: {
        slug: category.slug,
        name: category.name,
        imageUrl: category.imageUrl ?? null,
        imageAlt: category.imageAlt ?? null,
        showInHome: category.showInHome,
      },
    });
    await prisma.categoryTranslation.upsert({
      where: { categoryId_locale: { categoryId: row.id, locale: ES_LOCALE } },
      update: { name: category.nameEs },
      create: { categoryId: row.id, locale: ES_LOCALE, name: category.nameEs },
    });
    idsBySlug.set(category.slug, row.id);
  }
  return idsBySlug;
}

async function seedBrands(prisma: PrismaClient, data: SeedData): Promise<Map<string, string>> {
  const idsBySlug = new Map<string, string>();
  for (const brand of data.brands) {
    const row = await prisma.brand.upsert({
      where: { slug: brand.slug },
      update: { name: brand.name },
      create: { slug: brand.slug, name: brand.name },
    });
    idsBySlug.set(brand.slug, row.id);
  }
  return idsBySlug;
}

async function seedUsers(prisma: PrismaClient, data: SeedData): Promise<void> {
  for (const user of data.users) {
    const passwordHash = await argon2.hash(user.password, { type: argon2.argon2id });
    await prisma.user.upsert({
      where: { email: user.email },
      update: { passwordHash, name: user.name, role: user.role },
      create: { email: user.email, passwordHash, name: user.name, role: user.role },
    });
  }
}

async function seedProducts(
  prisma: PrismaClient,
  data: SeedData,
  categoryIds: Map<string, string>,
  brandIds: Map<string, string>,
  currency: string,
): Promise<void> {
  for (const product of data.products) {
    const categoryId = categoryIds.get(product.category);
    if (!categoryId) {
      throw new Error(
        `seed: product ${product.sku} references unknown category "${product.category}"`,
      );
    }
    const brandId = brandIds.get(product.brand);
    if (!brandId) {
      throw new Error(`seed: product ${product.sku} references unknown brand "${product.brand}"`);
    }
    // Category-level validation first: unknown keys or wrong types abort here.
    parseSpecs(product.category, product.specs);
    validateProductImages(product);

    const specs: Prisma.InputJsonValue = { ...product.specs };
    const row = await prisma.product.upsert({
      where: { sku: product.sku },
      update: {
        slug: product.slug,
        name: product.name,
        description: product.description,
        brandId,
        categoryId,
        priceAmount: product.priceAmount,
        currency,
        status: product.status,
        specs,
      },
      create: {
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        description: product.description,
        brandId,
        categoryId,
        priceAmount: product.priceAmount,
        currency,
        status: product.status,
        specs,
      },
    });

    // Images converge: replace the set so re-runs never append duplicates.
    await prisma.productImage.deleteMany({ where: { productId: row.id } });
    await prisma.productImage.createMany({
      data: product.images.map((url, index) => ({
        productId: row.id,
        url,
        alt: product.imageAlt ?? product.name,
        position: index,
      })),
    });

    await prisma.productTranslation.upsert({
      where: { productId_locale: { productId: row.id, locale: ES_LOCALE } },
      update: { name: product.nameEs, description: product.descriptionEs },
      create: {
        productId: row.id,
        locale: ES_LOCALE,
        name: product.nameEs,
        description: product.descriptionEs,
      },
    });

    await prisma.inventory.upsert({
      where: { productId: row.id },
      update: { stock: product.stock },
      create: { productId: row.id, stock: product.stock, reserved: 0 },
    });
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed: refusing to run with NODE_ENV=production (dev fixtures only)');
  }
  const connectionString = requireEnv('DATABASE_URL');
  const currency = process.env.BASE_CURRENCY ?? 'USD';

  const data = await loadSeedData(SEED_DATA_DIR);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const categoryIds = await seedCategories(prisma, data);
    const brandIds = await seedBrands(prisma, data);
    await seedUsers(prisma, data);
    await seedProducts(prisma, data, categoryIds, brandIds, currency);

    const [categories, brands, products, images, translations, inventory, users] =
      await Promise.all([
        prisma.category.count(),
        prisma.brand.count(),
        prisma.product.count(),
        prisma.productImage.count(),
        prisma.productTranslation.count(),
        prisma.inventory.count(),
        prisma.user.count(),
      ]);
    console.log(
      `seed: ok (currency=${currency}) — categories=${String(categories)} brands=${String(brands)} ` +
        `products=${String(products)} images=${String(images)} productTranslations=${String(translations)} ` +
        `inventory=${String(inventory)} users=${String(users)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
