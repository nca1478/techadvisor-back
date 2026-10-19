import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AiProviderError } from '../ai/ai-provider.error.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { RetrievalService, RetrievalHit } from '../retrieval/retrieval.service.js';
import { groupByProduct, SearchService, toSnippet } from './search.service.js';

const CONFIG = {
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: ['USD', 'EUR'],
  SUPPORTED_LOCALES: ['en', 'es'],
  DEFAULT_LOCALE: 'en',
} as unknown as AppConfig;

function hit(
  chunkId: string,
  productId: string | null,
  score: number,
  content = 'evidence',
): RetrievalHit {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    productId,
    content,
    locale: 'en',
    score,
    source: { title: `Title ${chunkId}`, docType: 'SPEC_SHEET', sourceUrl: null },
  };
}

function productRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: `Description ${id}`,
    brand: { id: 'brand-1', name: 'Brand', slug: 'brand' },
    category: {
      id: 'cat-1',
      name: 'Audio',
      slug: 'audio',
      parent: null,
      translations: [],
    },
    priceAmount: 100_00,
    currency: 'USD',
    specs: {},
    images: [{ url: 'https://cdn.example.com/p.jpg', alt: null, position: 0 }],
    prices: [],
    translations: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildService(options: {
  hits?: RetrievalHit[];
  fulltextHits?: RetrievalHit[];
  rows?: ReturnType<typeof productRow>[];
  lexicalRows?: ReturnType<typeof productRow>[];
  embedError?: Error;
  stock?: Map<string, number>;
}) {
  const searchMock = options.embedError
    ? vi.fn().mockRejectedValue(options.embedError)
    : vi.fn().mockResolvedValue(options.hits ?? []);
  const fulltextMock = vi.fn().mockResolvedValue(options.fulltextHits ?? []);
  const retrieval = {
    search: searchMock,
    searchFulltextOnly: fulltextMock,
  } as unknown as RetrievalService;
  const findManyCalls: unknown[] = [];
  const prisma = {
    product: {
      findMany: vi.fn().mockImplementation(
        (args?: {
          where?: {
            id?: { in?: string[] };
            OR?: unknown;
            category?: { slug?: string };
            brand?: { slug?: string };
          };
        }) => {
          // The lexical call carries an OR filter; RAG hydration filters by
          // id list. Mirrors production, where each query hits its own rows.
          findManyCalls.push(args);
          if (args?.where !== undefined && 'OR' in args.where) {
            return Promise.resolve(options.lexicalRows ?? []);
          }
          const ids = args?.where?.id?.in;
          const rows = options.rows ?? [];
          const scoped = ids === undefined ? rows : rows.filter((row) => ids.includes(row.id));
          // Browse path: honor the category/brand slug filters like Prisma
          // would, so filter tests stay faithful without a database.
          const category = args?.where?.category?.slug;
          const brand = args?.where?.brand?.slug;
          return Promise.resolve(
            scoped.filter(
              (row) =>
                (category === undefined || row.category.slug === category) &&
                (brand === undefined || row.brand.slug === brand),
            ),
          );
        },
      ),
    },
  } as unknown as PrismaService;
  const inventory = {
    getAvailabilityMap: vi
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(
          new Map(ids.map((id) => [id, options.stock?.get(id) ?? 5] as [string, number])),
        ),
      ),
  } as unknown as InventoryService;
  const service = new SearchService(retrieval, prisma, inventory, CONFIG);
  return { service, searchMock, fulltextMock, prisma, findManyCalls };
}

describe('groupByProduct', () => {
  it('keeps the best chunk per product and skips product-less hits', () => {
    const grouped = groupByProduct([
      hit('a', 'p1', 0.01, 'first'),
      hit('b', 'p1', 0.05, 'best'),
      hit('c', null, 0.09, 'policy'),
      hit('d', 'p2', 0.02, 'other'),
    ]);

    expect([...grouped.keys()]).toEqual(['p1', 'p2']);
    expect(grouped.get('p1')).toMatchObject({ score: 0.05, content: 'best' });
  });
});

describe('toSnippet', () => {
  it('collapses whitespace and truncates long content', () => {
    expect(toSnippet('  a\n  b ')).toBe('a b');
    const snippet = toSnippet('x'.repeat(300), 280);
    expect(snippet).toHaveLength(281);
    expect(snippet.endsWith('…')).toBe(true);
  });
});

describe('SearchService (unit, mocked retrieval and database)', () => {
  it('returns products ordered by score with SQL-hydrated price and stock', async () => {
    const { service } = buildService({
      hits: [hit('a', 'p1', 0.01), hit('b', 'p2', 0.09)],
      rows: [productRow('p1'), productRow('p2')],
    });

    const response = await service.search({ q: 'light headphones', limit: 12 });

    expect(response.degraded).toBe(false);
    expect(response.results.map((result) => result.product.id)).toEqual(['p2', 'p1']);
    expect(response.results[0]).toMatchObject({
      score: 0.09,
      product: {
        priceAmount: 100_00,
        currency: 'USD',
        inStock: true,
        availableQuantity: 5,
        imageUrl: 'https://cdn.example.com/p.jpg',
      },
    });
  });

  it('degrades to full-text when the embedding provider fails', async () => {
    const { service, fulltextMock } = buildService({
      embedError: new AiProviderError('server', 'provider down', 'fake'),
      fulltextHits: [hit('c', 'p1', 0.02, 'fulltext evidence')],
      rows: [productRow('p1')],
    });

    const response = await service.search({ q: 'headphones', limit: 12 });

    expect(fulltextMock).toHaveBeenCalledOnce();
    expect(response.degraded).toBe(true);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.snippet).toBe('fulltext evidence');
  });

  it('propagates non-provider errors instead of degrading', async () => {
    const { service, fulltextMock } = buildService({ embedError: new Error('bug') });

    await expect(service.search({ q: 'headphones', limit: 12 })).rejects.toThrow('bug');
    expect(fulltextMock).not.toHaveBeenCalled();
  });

  it('only returns ACTIVE products and applies category and maxPrice filters', async () => {
    const { service } = buildService({
      hits: [hit('a', 'p1', 0.05), hit('b', 'p2', 0.04), hit('c', 'p3', 0.03)],
      // p2 is missing: the SQL layer only returns ACTIVE products, so its
      // chunk (e.g. an ARCHIVED product) never becomes a result.
      rows: [
        productRow('p1', {
          category: { id: 'c1', name: 'Audio', slug: 'audio', parent: null, translations: [] },
        }),
        productRow('p3', {
          category: { id: 'c2', name: 'PC', slug: 'pc', parent: null, translations: [] },
          priceAmount: 50_00,
        }),
      ],
    });

    const byCategory = await service.search({ q: 'gear', category: 'audio', limit: 12 });
    expect(byCategory.results.map((result) => result.product.id)).toEqual(['p1']);

    const byPrice = await service.search({ q: 'gear', maxPrice: 60_00, limit: 12 });
    expect(byPrice.results.map((result) => result.product.id)).toEqual(['p3']);
  });

  it('rejects unsupported currencies with a 400', async () => {
    const { service } = buildService({ hits: [], rows: [] });

    await expect(
      service.search({ q: 'laptop', currency: 'ARS', limit: 12 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves the EUR price override for filtering', async () => {
    const { service } = buildService({
      hits: [hit('a', 'p1', 0.05)],
      rows: [productRow('p1', { prices: [{ currency: 'EUR', amount: 80_00 }] })],
    });

    const response = await service.search({
      q: 'laptop',
      currency: 'EUR',
      maxPrice: 90_00,
      limit: 12,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.product).toMatchObject({ priceAmount: 80_00, currency: 'EUR' });
  });

  it('browses by filters without q and never calls retrieval', async () => {
    const { service, searchMock } = buildService({
      rows: [productRow('p1', { priceAmount: 100_00 }), productRow('p2', { priceAmount: 50_00 })],
    });

    const response = await service.search({ q: '', maxPrice: 60_00, limit: 12 });

    expect(searchMock).not.toHaveBeenCalled();
    expect(response.query).toBe('');
    expect(response.degraded).toBe(false);
    expect(response.results.map((result) => result.product.id)).toEqual(['p2']);
    expect(response.results[0]).toMatchObject({ score: 0 });
    expect(typeof response.results[0]?.snippet).toBe('string');
  });

  it('returns empty when neither retrieval nor the catalog match', async () => {
    const { service } = buildService({ hits: [], rows: [] });

    const response = await service.search({ q: 'zzz-no-such-thing', limit: 12 });

    expect(response.results).toEqual([]);
    expect(response.degraded).toBe(false);
  });

  it('drops unrelated vector neighbours when the catalog matches (brand query)', async () => {
    // Regression test for "Kingston" returning Asus/Seasonic: the only RAG
    // chunks belong to other products, but the catalog has brand matches.
    const kingston = productRow('p-kingston', {
      sku: 'KIN-FURY-DDR5',
      name: 'Kingston Fury Beast DDR5 32GB',
      description: 'Kingston Fury Beast DDR5 32GB (2x16GB) 5200MT/s',
      brand: { id: 'brand-kingston', name: 'Kingston', slug: 'kingston' },
    });
    const { service, findManyCalls } = buildService({
      hits: [hit('a', 'p-unrelated', 0.016, '## Specifications')],
      rows: [productRow('p-unrelated')],
      lexicalRows: [kingston],
    });

    const response = await service.search({ q: 'Kingston', limit: 12 });

    expect(response.results.map((result) => result.product.id)).toEqual(['p-kingston']);
    expect(response.results[0]).toMatchObject({
      score: 1,
      product: { inStock: true, imageUrl: 'https://cdn.example.com/p.jpg' },
    });
    expect(response.results[0]?.snippet).toContain('Kingston Fury Beast');
    // RAG hydration is skipped when lexical matches exist (one query saved).
    expect(findManyCalls).toHaveLength(1);
  });

  it('keeps the chunk snippet when a product matches both lexical and retrieval', async () => {
    const row = productRow('p1');
    const { service } = buildService({
      hits: [hit('a', 'p1', 0.03, 'chunk evidence')],
      rows: [row],
      lexicalRows: [row],
    });

    const response = await service.search({ q: 'Product p1', limit: 12 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ score: 1.03, snippet: 'chunk evidence' });
  });

  it('orders lexical matches deterministically and applies filters to them', async () => {
    const { service } = buildService({
      hits: [hit('a', 'p-unrelated', 0.016)],
      rows: [productRow('p-unrelated')],
      lexicalRows: [
        productRow('p2', {
          name: 'Kingston ValueRAM DDR4 8GB',
          category: { id: 'c2', name: 'PC', slug: 'pc', parent: null, translations: [] },
          priceAmount: 50_00,
        }),
        productRow('p1', {
          name: 'Kingston Fury Beast DDR5 32GB',
          category: { id: 'c1', name: 'Audio', slug: 'audio', parent: null, translations: [] },
        }),
      ],
    });

    const all = await service.search({ q: 'Kingston', limit: 12 });
    expect(all.results.map((result) => result.product.id)).toEqual(['p1', 'p2']);

    const byCategory = await service.search({ q: 'Kingston', category: 'audio', limit: 12 });
    expect(byCategory.results.map((result) => result.product.id)).toEqual(['p1']);

    const byPrice = await service.search({ q: 'Kingston', maxPrice: 60_00, limit: 12 });
    expect(byPrice.results.map((result) => result.product.id)).toEqual(['p2']);
  });

  it('filters by brand slug in both search and browse modes', async () => {
    const acme = productRow('p-acme', {
      name: 'Acme Widget',
      brand: { id: 'brand-acme', name: 'Acme', slug: 'acme' },
    });
    const other = productRow('p-other', {
      name: 'Other Widget',
      brand: { id: 'brand-other', name: 'Other', slug: 'other' },
    });
    const { service } = buildService({
      hits: [hit('a', 'p-acme', 0.05), hit('b', 'p-other', 0.04)],
      rows: [acme, other],
      lexicalRows: [acme, other],
    });

    const byBrand = await service.search({ q: 'Widget', brand: 'acme', limit: 12 });
    expect(byBrand.results.map((result) => result.product.id)).toEqual(['p-acme']);

    const browse = await service.search({ q: '', brand: 'other', limit: 12 });
    expect(browse.results.map((result) => result.product.id)).toEqual(['p-other']);
  });

  it('filters out-of-stock products when inStock is set', async () => {
    const available = productRow('p-available', { name: 'Available Widget' });
    const soldOut = productRow('p-soldout', { name: 'Soldout Widget' });
    const { service } = buildService({
      hits: [hit('a', 'p-available', 0.05), hit('b', 'p-soldout', 0.09)],
      rows: [available, soldOut],
      lexicalRows: [available, soldOut],
      stock: new Map([
        ['p-available', 5],
        ['p-soldout', 0],
      ]),
    });

    const all = await service.search({ q: 'Widget', limit: 12 });
    expect(all.results.map((result) => result.product.id).sort()).toEqual(
      ['p-available', 'p-soldout'].sort(),
    );

    const inStock = await service.search({ q: 'Widget', inStock: '1', limit: 12 });
    expect(inStock.results.map((result) => result.product.id)).toEqual(['p-available']);

    const browse = await service.search({ q: '', inStock: 'true', limit: 12 });
    expect(browse.results.map((result) => result.product.id)).toEqual(['p-available']);
  });

  it('applies explicit sort instead of relevance order', async () => {
    const cheap = productRow('p-cheap', {
      name: 'B Widget',
      priceAmount: 10_00,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const expensive = productRow('p-expensive', {
      name: 'A Widget',
      priceAmount: 90_00,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const { service } = buildService({
      hits: [hit('a', 'p-cheap', 0.09), hit('b', 'p-expensive', 0.01)],
      rows: [cheap, expensive],
    });

    const cheapest = await service.search({ q: 'Widget', sort: 'price_asc', limit: 12 });
    expect(cheapest.results.map((result) => result.product.id)).toEqual(['p-cheap', 'p-expensive']);

    const priciest = await service.search({ q: 'Widget', sort: 'price_desc', limit: 12 });
    expect(priciest.results.map((result) => result.product.id)).toEqual(['p-expensive', 'p-cheap']);

    const newest = await service.search({ q: '', sort: 'newest', limit: 12 });
    expect(newest.results.map((result) => result.product.id)).toEqual(['p-expensive', 'p-cheap']);
  });
});
