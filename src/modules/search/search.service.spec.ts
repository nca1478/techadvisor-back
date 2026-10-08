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
  embedError?: Error;
}) {
  const searchMock = options.embedError
    ? vi.fn().mockRejectedValue(options.embedError)
    : vi.fn().mockResolvedValue(options.hits ?? []);
  const fulltextMock = vi.fn().mockResolvedValue(options.fulltextHits ?? []);
  const retrieval = {
    search: searchMock,
    searchFulltextOnly: fulltextMock,
  } as unknown as RetrievalService;
  const prisma = {
    product: { findMany: vi.fn().mockResolvedValue(options.rows ?? []) },
  } as unknown as PrismaService;
  const inventory = {
    getAvailabilityMap: vi
      .fn()
      .mockResolvedValue(new Map((options.rows ?? []).map((row) => [row.id, 5]))),
  } as unknown as InventoryService;
  const service = new SearchService(retrieval, prisma, inventory, CONFIG);
  return { service, searchMock, fulltextMock, prisma };
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
});
