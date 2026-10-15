import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageUrlSchema, parseSpecs } from '../../src/modules/catalog/specs/index.js';
import { loadSeedData, type SeedData } from './seed-input.js';

const SEED_DATA_DIR = dirname(fileURLToPath(import.meta.url));

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

describe('seed fixtures', () => {
  let data: SeedData;

  beforeAll(async () => {
    data = await loadSeedData(SEED_DATA_DIR);
  });

  it('loads the expected catalog volume', () => {
    expect(data.categories.length).toBeGreaterThanOrEqual(6);
    expect(data.categories.length).toBeLessThanOrEqual(8);
    expect(data.brands.length).toBeGreaterThanOrEqual(8);
    // Real-catalog seed (SpeedLogic, ADR 0046): 25 board-partner brands.
    expect(data.brands.length).toBeLessThanOrEqual(30);
    expect(data.products.length).toBeGreaterThanOrEqual(35);
  });

  it('has no duplicate business keys', () => {
    expect(findDuplicates(data.categories.map((row) => row.slug))).toEqual([]);
    expect(findDuplicates(data.brands.map((row) => row.slug))).toEqual([]);
    expect(findDuplicates(data.products.map((row) => row.sku))).toEqual([]);
    expect(findDuplicates(data.products.map((row) => row.slug))).toEqual([]);
    expect(findDuplicates(data.users.map((row) => row.email))).toEqual([]);
  });

  it('references only known brands and categories', () => {
    const brandSlugs = new Set(data.brands.map((row) => row.slug));
    const categorySlugs = new Set(data.categories.map((row) => row.slug));
    for (const product of data.products) {
      expect(brandSlugs.has(product.brand), `product ${product.sku} brand`).toBe(true);
      expect(categorySlugs.has(product.category), `product ${product.sku} category`).toBe(true);
    }
  });

  it('passes the category specs schemas for every product', () => {
    for (const product of data.products) {
      // Throws on unknown keys or wrong types — the same call the seed runs.
      expect(
        () => parseSpecs(product.category, product.specs),
        `specs of ${product.sku}`,
      ).not.toThrow();
    }
  });

  it('uses only valid https image URLs', () => {
    for (const product of data.products) {
      for (const url of product.images) {
        expect(() => imageUrlSchema.parse(url), `image of ${product.sku}`).not.toThrow();
      }
    }
    for (const category of data.categories) {
      if (category.imageUrl !== undefined) {
        expect(() => imageUrlSchema.parse(category.imageUrl as string)).not.toThrow();
      }
    }
  });

  it('gives every category a home cover image and visibility flag', () => {
    for (const category of data.categories) {
      expect(category.imageUrl?.length ?? 0, `cover of ${category.slug}`).toBeGreaterThan(0);
      expect(typeof category.showInHome, `visibility of ${category.slug}`).toBe('boolean');
    }
  });

  it('covers both languages, varied stock and both sockets', () => {
    for (const product of data.products) {
      expect(product.nameEs.length, `es name of ${product.sku}`).toBeGreaterThan(0);
      expect(product.descriptionEs.length, `es description of ${product.sku}`).toBeGreaterThan(0);
    }
    expect(
      data.products.some((row) => row.stock === 0),
      'some out-of-stock product',
    ).toBe(true);
    const sockets = new Set(
      data.products
        .filter((row) => row.category === 'cpus')
        .map((row) => String(row.specs['socket'])),
    );
    expect(sockets.has('AM5'), 'AM5 cpu present').toBe(true);
    expect(sockets.has('LGA1700'), 'LGA1700 cpu present').toBe(true);
    const ramTypes = new Set(
      data.products
        .filter((row) => row.category === 'ram')
        .map((row) => String(row.specs['ram_type'])),
    );
    expect(ramTypes.has('DDR4'), 'DDR4 ram present').toBe(true);
    expect(ramTypes.has('DDR5'), 'DDR5 ram present').toBe(true);
  });

  it('seeds one ADMIN and one CUSTOMER user', () => {
    const roles = data.users.map((row) => row.role).sort();
    expect(roles).toEqual(['ADMIN', 'CUSTOMER']);
  });
});
