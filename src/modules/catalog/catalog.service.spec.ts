import { catalogQuerySchema } from './catalog-query.schema.js';
import {
  buildProductOrderBy,
  buildProductWhere,
  pickLocalizedText,
  resolveLocale,
  resolvePrice,
  toPaginationMeta,
} from './catalog.service.js';
import { getSpecsFields } from './specs/index.js';
import { imageUrlSchema, parseSpecs } from './specs/specs.schemas.js';

describe('resolveLocale', () => {
  it('keeps a supported locale and falls back otherwise', () => {
    expect(resolveLocale('es', ['en', 'es'], 'en')).toBe('es');
    expect(resolveLocale('fr', ['en', 'es'], 'en')).toBe('en');
    expect(resolveLocale(undefined, ['en', 'es'], 'en')).toBe('en');
  });
});

describe('pickLocalizedText', () => {
  it('prefers the translation and falls back to the base text', () => {
    const translations: { locale: string; name: string }[] = [{ locale: 'es', name: 'Portátil' }];
    const byName = (row: { name: string }): string => row.name;
    expect(pickLocalizedText(translations, 'es', byName, 'Laptop')).toBe('Portátil');
    expect(pickLocalizedText(translations, 'en', byName, 'Laptop')).toBe('Laptop');
    expect(pickLocalizedText([], 'es', byName, 'Laptop')).toBe('Laptop');
  });
});

describe('resolvePrice', () => {
  const base = { amount: 100_00, currency: 'USD' };

  it('uses the fixed override when the requested currency has one', () => {
    expect(resolvePrice(base, [{ currency: 'EUR', amount: 90_00 }], 'EUR')).toEqual({
      amount: 90_00,
      currency: 'EUR',
    });
  });

  it('falls back to the base price when there is no override', () => {
    expect(resolvePrice(base, [], 'EUR')).toEqual({ amount: 100_00, currency: 'USD' });
    expect(resolvePrice(base, [{ currency: 'EUR', amount: 90_00 }], 'USD')).toEqual({
      amount: 100_00,
      currency: 'USD',
    });
  });
});

describe('buildProductWhere', () => {
  it('always scopes to ACTIVE products', () => {
    expect(buildProductWhere({ currency: 'USD' })).toEqual({ status: 'ACTIVE' });
  });

  it('combines category, brand and text filters', () => {
    const where = buildProductWhere({
      currency: 'USD',
      category: 'laptops',
      brand: 'acme',
      q: 'ultra',
    });
    expect(where).toMatchObject({
      status: 'ACTIVE',
      category: { slug: 'laptops' },
      brand: { slug: 'acme' },
    });
    expect(where.OR).toHaveLength(3);
  });

  it('applies the price range to the price in the requested currency (base or override)', () => {
    const where = buildProductWhere({ currency: 'EUR', minPrice: 10_00, maxPrice: 50_00 });
    expect(where.AND).toEqual([
      {
        OR: [
          { currency: 'EUR', priceAmount: { gte: 10_00, lte: 50_00 } },
          { prices: { some: { currency: 'EUR', amount: { gte: 10_00, lte: 50_00 } } } },
        ],
      },
    ]);
  });

  it('supports open-ended ranges', () => {
    const minOnly = buildProductWhere({ currency: 'USD', minPrice: 5_00 });
    expect(minOnly.AND).toEqual([
      {
        OR: [
          { currency: 'USD', priceAmount: { gte: 5_00 } },
          { prices: { some: { currency: 'USD', amount: { gte: 5_00 } } } },
        ],
      },
    ]);
    const maxOnly = buildProductWhere({ currency: 'USD', maxPrice: 5_00 });
    expect(maxOnly.AND).toEqual([
      {
        OR: [
          { currency: 'USD', priceAmount: { lte: 5_00 } },
          { prices: { some: { currency: 'USD', amount: { lte: 5_00 } } } },
        ],
      },
    ]);
  });

  it('adds no price clause without bounds', () => {
    expect(buildProductWhere({ currency: 'USD' })).not.toHaveProperty('AND');
  });
});

describe('buildProductOrderBy', () => {
  it('maps every sort with a stable id tiebreak', () => {
    expect(buildProductOrderBy('price_asc')).toEqual([{ priceAmount: 'asc' }, { id: 'asc' }]);
    expect(buildProductOrderBy('price_desc')).toEqual([{ priceAmount: 'desc' }, { id: 'asc' }]);
    expect(buildProductOrderBy('name_asc')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    expect(buildProductOrderBy('name_desc')).toEqual([{ name: 'desc' }, { id: 'asc' }]);
    expect(buildProductOrderBy('newest')).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('toPaginationMeta', () => {
  it('computes totals and navigation flags', () => {
    expect(toPaginationMeta(1, 20, 0)).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
    expect(toPaginationMeta(2, 20, 45)).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
    expect(toPaginationMeta(3, 20, 45)).toMatchObject({ hasNext: false, hasPrev: true });
  });
});

describe('specs field definitions', () => {
  it('exposes typed snake_case fields for laptops and PC components', () => {
    for (const slug of ['laptops', 'cpus', 'motherboards', 'ram', 'gpus', 'storage', 'psus']) {
      const fields = getSpecsFields(slug);
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(field.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns an empty schema for unknown categories', () => {
    expect(getSpecsFields('toasters')).toEqual([]);
  });

  it('covers the required keys from the task', () => {
    const laptopKeys = getSpecsFields('laptops').map((field) => field.key);
    for (const key of ['ram_gb', 'storage_gb', 'cpu', 'screen_inches']) {
      expect(laptopKeys).toContain(key);
    }
    const componentKeys = [
      ...getSpecsFields('cpus'),
      ...getSpecsFields('motherboards'),
      ...getSpecsFields('ram'),
    ].map((field) => field.key);
    for (const key of ['socket', 'ram_type']) {
      expect(componentKeys).toContain(key);
    }
  });
});

describe('imageUrlSchema', () => {
  it('accepts https URLs within the length bound', () => {
    expect(imageUrlSchema.safeParse('https://cdn.example.com/p/img.jpg').success).toBe(true);
  });

  it.each([
    'http://cdn.example.com/p/img.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AAA',
    'not-a-url',
  ])('rejects %s', (url) => {
    expect(imageUrlSchema.safeParse(url).success).toBe(false);
  });

  it('rejects URLs longer than the column', () => {
    expect(imageUrlSchema.safeParse(`https://cdn.example.com/${'a'.repeat(2048)}`).success).toBe(
      false,
    );
  });
});

describe('parseSpecs', () => {
  it('accepts valid laptop specs', () => {
    expect(parseSpecs('laptops', { ram_gb: 16, cpu: 'Ultra 7 155H' })).toEqual({
      ram_gb: 16,
      cpu: 'Ultra 7 155H',
    });
  });

  it('rejects wrong types and unknown keys', () => {
    expect(() => parseSpecs('laptops', { ram_gb: 'sixteen' })).toThrow();
    expect(() => parseSpecs('laptops', { overclocked_to_the_moon: true })).toThrow();
  });

  it('restricts enums to their options', () => {
    expect(() => parseSpecs('ram', { ram_type: 'DDR6' })).toThrow();
    expect(parseSpecs('ram', { ram_type: 'DDR5', ram_gb: 32 })).toEqual({
      ram_type: 'DDR5',
      ram_gb: 32,
    });
  });
});

describe('catalogQuerySchema', () => {
  it('applies defaults for sort, page and limit', () => {
    expect(catalogQuerySchema.parse({})).toMatchObject({ sort: 'newest', page: 1, limit: 20 });
  });

  it('coerces numeric strings from the query string', () => {
    expect(catalogQuerySchema.parse({ page: '2', limit: '5', minPrice: '1000' })).toMatchObject({
      page: 2,
      limit: 5,
      minPrice: 1000,
    });
  });

  it('rejects inverted ranges and out-of-range limits', () => {
    expect(catalogQuerySchema.safeParse({ minPrice: 500, maxPrice: 100 }).success).toBe(false);
    expect(catalogQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(catalogQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});
