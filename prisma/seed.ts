/**
 * Idempotent development/demo seed (`npm run seed` → `tsx prisma/seed.ts`).
 *
 * - Create-if-not-exists on business keys (`slug`/`sku`/email), following the
 *   `05-control-asistencia-opencode` pattern (`upsert` with `update: {}`):
 *   running it twice never duplicates rows and never overwrites existing
 *   ones — if the record exists it is left untouched.
 * - Every new product row is validated against the category Zod specs schemas
 *   (`parseSpecs`) and every new image against `imageUrlSchema` before
 *   touching the database; existing rows are skipped without re-validating.
 * - Every run prints one `created/skipped` line per table, so it is clear
 *   which tables gained rows and which were left untouched.
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

/** Created vs skipped counters for one table. */
interface TableCount {
  created: number;
  skipped: number;
}

type SeedReport = Record<string, TableCount>;

function emptyCount(): TableCount {
  return { created: 0, skipped: 0 };
}

function mergeReport(into: SeedReport, table: string, count: TableCount): void {
  const current = into[table] ?? emptyCount();
  into[table] = {
    created: current.created + count.created,
    skipped: current.skipped + count.skipped,
  };
}

/**
 * One line per table so every run reports which tables gained rows and
 * which tables were left untouched:
 * `seed: categories → created=5 skipped=0`.
 */
function logSeedReport(report: SeedReport): void {
  for (const [table, count] of Object.entries(report)) {
    console.log(
      `seed: ${table} → created=${String(count.created)} skipped=${String(count.skipped)}`,
    );
  }
}

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

async function seedCategories(
  prisma: PrismaClient,
  data: SeedData,
): Promise<{ idsBySlug: Map<string, string>; report: SeedReport }> {
  const idsBySlug = new Map<string, string>();
  const report: SeedReport = { categories: emptyCount(), categoryTranslations: emptyCount() };
  const existingSlugs = new Set(
    (
      await prisma.category.findMany({
        where: { slug: { in: data.categories.map((category) => category.slug) } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  for (const category of data.categories) {
    if (category.imageUrl !== undefined) {
      imageUrlSchema.parse(category.imageUrl);
    }
    // Create-if-not-exists (05-control-asistencia pattern): existing rows are
    // left untouched (`update: {}`), never overwritten.
    const isNew = !existingSlugs.has(category.slug);
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      update: {},
      create: {
        slug: category.slug,
        name: category.name,
        imageUrl: category.imageUrl ?? null,
        imageAlt: category.imageAlt ?? null,
        showInHome: category.showInHome,
      },
    });
    report.categories[isNew ? 'created' : 'skipped'] += 1;
    const translationExists = await prisma.categoryTranslation.findUnique({
      where: { categoryId_locale: { categoryId: row.id, locale: ES_LOCALE } },
      select: { categoryId: true },
    });
    if (translationExists) {
      report.categoryTranslations.skipped += 1;
    } else {
      await prisma.categoryTranslation.create({
        data: { categoryId: row.id, locale: ES_LOCALE, name: category.nameEs },
      });
      report.categoryTranslations.created += 1;
    }
    idsBySlug.set(category.slug, row.id);
  }
  return { idsBySlug, report };
}

async function seedBrands(
  prisma: PrismaClient,
  data: SeedData,
): Promise<{ idsBySlug: Map<string, string>; report: SeedReport }> {
  const idsBySlug = new Map<string, string>();
  const report: SeedReport = { brands: emptyCount() };
  const existingSlugs = new Set(
    (
      await prisma.brand.findMany({
        where: { slug: { in: data.brands.map((brand) => brand.slug) } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  for (const brand of data.brands) {
    const isNew = !existingSlugs.has(brand.slug);
    const row = await prisma.brand.upsert({
      where: { slug: brand.slug },
      update: {},
      create: { slug: brand.slug, name: brand.name },
    });
    report.brands[isNew ? 'created' : 'skipped'] += 1;
    idsBySlug.set(brand.slug, row.id);
  }
  return { idsBySlug, report };
}

async function seedUsers(prisma: PrismaClient, data: SeedData): Promise<SeedReport> {
  const report: SeedReport = { users: emptyCount() };
  const existingEmails = new Set(
    (
      await prisma.user.findMany({
        where: { email: { in: data.users.map((user) => user.email) } },
        select: { email: true },
      })
    ).map((row) => row.email),
  );
  for (const user of data.users) {
    // Skip the argon2 cost entirely when the user already exists.
    if (existingEmails.has(user.email)) {
      report.users.skipped += 1;
      continue;
    }
    const passwordHash = await argon2.hash(user.password, { type: argon2.argon2id });
    await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: {
        email: user.email,
        passwordHash,
        name: user.name,
        role: user.role,
        provider: 'LOCAL',
      },
    });
    report.users.created += 1;
  }
  return report;
}

async function seedProducts(
  prisma: PrismaClient,
  data: SeedData,
  categoryIds: Map<string, string>,
  brandIds: Map<string, string>,
  currency: string,
): Promise<SeedReport> {
  const report: SeedReport = {
    products: emptyCount(),
    productImages: emptyCount(),
    productTranslations: emptyCount(),
    inventory: emptyCount(),
  };
  const existingBySku = new Map(
    (
      await prisma.product.findMany({
        where: { sku: { in: data.products.map((product) => product.sku) } },
        select: { id: true, sku: true },
      })
    ).map((row) => [row.sku, row.id] as const),
  );
  const skippedIds: string[] = [];
  for (const product of data.products) {
    // Create-if-not-exists: an existing sku is left completely untouched
    // (product row, images, translation and inventory are preserved as-is).
    const existingId = existingBySku.get(product.sku);
    if (existingId !== undefined) {
      report.products.skipped += 1;
      skippedIds.push(existingId);
      continue;
    }
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
      update: {},
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

    // Images are written only for newly created products, so re-runs never
    // append duplicates nor overwrite manual changes.
    await prisma.productImage.createMany({
      data: product.images.map((url, index) => ({
        productId: row.id,
        url,
        alt: product.imageAlt ?? product.name,
        position: index,
      })),
    });
    report.products.created += 1;
    report.productImages.created += product.images.length;

    await prisma.productTranslation.upsert({
      where: { productId_locale: { productId: row.id, locale: ES_LOCALE } },
      update: {},
      create: {
        productId: row.id,
        locale: ES_LOCALE,
        name: product.nameEs,
        description: product.descriptionEs,
      },
    });
    report.productTranslations.created += 1;

    await prisma.inventory.upsert({
      where: { productId: row.id },
      update: {},
      create: { productId: row.id, stock: product.stock, reserved: 0 },
    });
    report.inventory.created += 1;
  }
  // Child rows of skipped products are preserved as-is; count them so the
  // summary reports exactly which tables were left untouched.
  if (skippedIds.length > 0) {
    const [skippedImages, skippedTranslations, skippedInventory] = await Promise.all([
      prisma.productImage.count({ where: { productId: { in: skippedIds } } }),
      prisma.productTranslation.count({ where: { productId: { in: skippedIds } } }),
      prisma.inventory.count({ where: { productId: { in: skippedIds } } }),
    ]);
    report.productImages.skipped += skippedImages;
    report.productTranslations.skipped += skippedTranslations;
    report.inventory.skipped += skippedInventory;
  }
  return report;
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
    const { idsBySlug: categoryIds, report: categoryReport } = await seedCategories(prisma, data);
    const { idsBySlug: brandIds, report: brandReport } = await seedBrands(prisma, data);
    const userReport = await seedUsers(prisma, data);
    const productReport = await seedProducts(prisma, data, categoryIds, brandIds, currency);

    const report: SeedReport = {};
    for (const partial of [categoryReport, brandReport, userReport, productReport]) {
      for (const [table, count] of Object.entries(partial)) {
        mergeReport(report, table, count);
      }
    }
    console.log(`seed: ok (currency=${currency})`);
    logSeedReport(report);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
