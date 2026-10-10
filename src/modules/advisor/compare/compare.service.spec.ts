import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/env.schema.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { FakeLlmAdapter } from '../../ai/adapters/fake-llm.adapter.js';
import type { RetrievalService, RetrievalHit } from '../../retrieval/retrieval.service.js';
import { buildDeterministicSummary, CompareService } from './compare.service.js';
import {
  buildComparisonTable,
  buildPriceRow,
  findForeignUuids,
  unionSpecKeys,
  type ComparableProduct,
} from './comparison-table.js';
import {
  buildCompareUserMessage,
  loadCompareSystemPrompt,
  renderCompareSystemPrompt,
} from './prompts/compare.prompt.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const FOREIGN_ID = '99999999-9999-4999-8999-999999999999';

const CONFIG = {
  SUPPORTED_LOCALES: ['en', 'es'],
  DEFAULT_LOCALE: 'en',
} as unknown as AppConfig;

function hit(chunkId: string, productId: string | null, score: number): RetrievalHit {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    productId,
    content: `evidence ${chunkId}`,
    locale: 'en',
    score,
    source: { title: `Title ${chunkId}`, docType: 'MANUAL', sourceUrl: null },
  };
}

function row(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { category: { slug: string } } {
  return {
    id,
    name: `Product ${id.slice(0, 4)}`,
    slug: `product-${id.slice(0, 4)}`,
    priceAmount: 100_00,
    currency: 'USD',
    specs: { ram_gb: 16, socket: 'AM5' },
    category: { slug: 'laptops' },
    ...overrides,
  };
}

function buildService(options: {
  rows?: ReturnType<typeof row>[];
  hitsByProduct?: Record<string, RetrievalHit[]>;
  generalHits?: RetrievalHit[];
  llmText?: string;
  llmQueue?: string[];
  retrievalFails?: boolean;
}) {
  const rows = options.rows ?? [row(ID_A), row(ID_B)];
  const searchMock = vi.fn((input: { filters?: { productId?: string } }) => {
    if (options.retrievalFails === true) {
      return Promise.reject(new Error('retrieval down'));
    }
    if (input.filters?.productId !== undefined) {
      return Promise.resolve(options.hitsByProduct?.[input.filters.productId] ?? []);
    }
    return Promise.resolve(options.generalHits ?? []);
  });
  const retrieval = {
    search: searchMock,
    searchFulltextOnly: vi.fn().mockRejectedValue(new Error('fulltext down')),
  } as unknown as RetrievalService;
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { product: { findMany } } as unknown as PrismaService;
  const llm = new FakeLlmAdapter({ defaultText: options.llmText ?? 'B has more RAM [1].' });
  if (options.llmQueue !== undefined) {
    llm.enqueueTexts(options.llmQueue);
  }
  const service = new CompareService(prisma, retrieval, llm, CONFIG);
  return { service, searchMock, findMany, llm };
}

describe('buildComparisonTable (pure)', () => {
  const products: ComparableProduct[] = [
    { id: 'a', name: 'A', slug: 'a', priceAmount: 100_00, currency: 'USD', specs: { ram_gb: 16 } },
    { id: 'b', name: 'B', slug: 'b', priceAmount: 80_00, currency: 'USD', specs: { ram_gb: 32 } },
  ];

  it('builds a price row plus one row per spec key', () => {
    const table = buildComparisonTable(products);

    expect(table.map((entry) => entry.key)).toEqual(['price_amount', 'ram_gb']);
    expect(table[0]).toMatchObject({ values: [100_00, 80_00], best: [1], direction: 'lower' });
    expect(table[1]).toMatchObject({ values: [16, 32], best: [1], direction: 'higher' });
  });

  it('marks ties on every tied column', () => {
    const tied: ComparableProduct[] = [
      { id: 'a', name: 'A', slug: 'a', priceAmount: 50_00, currency: 'USD', specs: { ram_gb: 16 } },
      { id: 'b', name: 'B', slug: 'b', priceAmount: 50_00, currency: 'USD', specs: { ram_gb: 16 } },
    ];

    const table = buildComparisonTable(tied);

    expect(table[0]?.best).toEqual([0, 1]);
    expect(table[1]?.best).toEqual([0, 1]);
  });

  it('aligns missing specs as null with no best', () => {
    const partial: ComparableProduct[] = [
      {
        id: 'a',
        name: 'A',
        slug: 'a',
        priceAmount: 100_00,
        currency: 'USD',
        specs: { ram_gb: 16 },
      },
      { id: 'b', name: 'B', slug: 'b', priceAmount: 90_00, currency: 'USD', specs: {} },
    ];

    const table = buildComparisonTable(partial);
    const ram = table.find((entry) => entry.key === 'ram_gb');

    expect(unionSpecKeys(partial)).toEqual(['ram_gb']);
    expect(ram).toMatchObject({ values: [16, null], best: [], direction: null });
  });

  it('never highlights text specs or ambiguous numerics like tdp_w', () => {
    const productsWithText: ComparableProduct[] = [
      {
        id: 'a',
        name: 'A',
        slug: 'a',
        priceAmount: 100_00,
        currency: 'USD',
        specs: { socket: 'AM5', tdp_w: 65 },
      },
      {
        id: 'b',
        name: 'B',
        slug: 'b',
        priceAmount: 90_00,
        currency: 'USD',
        specs: { socket: 'LGA1700', tdp_w: 125 },
      },
    ];

    const table = buildComparisonTable(productsWithText);

    expect(table.find((entry) => entry.key === 'socket')).toMatchObject({
      values: ['AM5', 'LGA1700'],
      best: [],
      direction: null,
    });
    expect(table.find((entry) => entry.key === 'tdp_w')).toMatchObject({
      best: [],
      direction: null,
    });
  });

  it('leaves price best empty when currencies differ', () => {
    const mixed: ComparableProduct[] = [
      { id: 'a', name: 'A', slug: 'a', priceAmount: 100_00, currency: 'USD', specs: {} },
      { id: 'b', name: 'B', slug: 'b', priceAmount: 90_00, currency: 'EUR', specs: {} },
    ];

    expect(buildPriceRow(mixed)).toMatchObject({ best: [], direction: null });
  });
});

describe('findForeignUuids (pure)', () => {
  it('returns UUIDs outside the compared set', () => {
    expect(findForeignUuids(`see ${FOREIGN_ID} and ${ID_A}`, new Set([ID_A, ID_B]))).toEqual([
      FOREIGN_ID,
    ]);
  });

  it('is empty when only compared ids (any case) are mentioned', () => {
    expect(
      findForeignUuids(`see ${ID_A.toUpperCase()} and ${ID_B}`, new Set([ID_A, ID_B])),
    ).toEqual([]);
  });

  it('ignores citation markers like [1]', () => {
    expect(findForeignUuids('better RAM [1] and battery [2]', new Set([ID_A]))).toEqual([]);
  });
});

describe('CompareService (unit, mocked database and retrieval)', () => {
  it('compares 2 products: SQL table + cited LLM summary', async () => {
    const { service, llm } = buildService({
      rows: [
        row(ID_A, { priceAmount: 100_00, specs: { ram_gb: 16, socket: 'AM5' } }),
        row(ID_B, { priceAmount: 80_00, specs: { ram_gb: 32, socket: 'AM5' } }),
      ],
      hitsByProduct: { [ID_A]: [hit('a1', ID_A, 0.05)], [ID_B]: [hit('b1', ID_B, 0.04)] },
      llmText: 'B offers more RAM [2] at a lower price.',
    });

    const response = await service.compare({ productIds: [ID_A, ID_B], useCase: 'studying' });

    expect(response.products.map((product) => product.productId)).toEqual([ID_A, ID_B]);
    // Figures come from SQL, in request order.
    expect(response.products.map((product) => product.priceAmount)).toEqual([100_00, 80_00]);
    const ram = response.table.find((entry) => entry.key === 'ram_gb');
    expect(ram).toMatchObject({ values: [16, 32], best: [1], direction: 'higher' });
    const price = response.table.find((entry) => entry.key === 'price_amount');
    expect(price).toMatchObject({ values: [100_00, 80_00], best: [1], direction: 'lower' });
    // Two laptops: no board/CPU/RAM pair rules apply, so no issues.
    expect(response.compatibility.compatible).toBe(true);
    expect(response.summary).toContain('B offers more RAM');
    expect(response.citations.length).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(1);
    // The prompt carries the SQL table, the engine verdict and the use case.
    const sent = llm.calls[0]?.messages[0]?.content ?? '';
    expect(sent).toContain('COMPARISON TABLE');
    expect(sent).toContain('10000 USD');
    expect(sent).toContain('COMPATIBILITY RESULT');
    expect(sent).toContain('studying');
  });

  it('compares 3 products with missing specs (null cells, no best)', async () => {
    const { service } = buildService({
      rows: [
        row(ID_A, { priceAmount: 100_00, specs: { ram_gb: 16 } }),
        row(ID_B, { priceAmount: 120_00, specs: { ram_gb: 32 } }),
        row(ID_C, { priceAmount: 90_00, specs: {} }),
      ],
      llmText: 'C is the cheapest option.',
    });

    const response = await service.compare({ productIds: [ID_A, ID_B, ID_C] });

    expect(response.products).toHaveLength(3);
    const ram = response.table.find((entry) => entry.key === 'ram_gb');
    expect(ram).toMatchObject({ values: [16, 32, null], best: [], direction: null });
    const price = response.table.find((entry) => entry.key === 'price_amount');
    expect(price).toMatchObject({ values: [100_00, 120_00, 90_00], best: [2] });
    expect(response.summary).toContain('cheapest');
  });

  it('includes the deterministic compatibility verdict as data', async () => {
    // CPU + motherboard with clashing sockets: the engine (not the LLM)
    // decides incompatibility and the verdict reaches the prompt as fact.
    const { service, llm } = buildService({
      rows: [
        row(ID_A, { specs: { socket: 'AM5', tdp_w: 65 }, category: { slug: 'cpus' } }),
        row(ID_B, {
          specs: { socket: 'LGA1700', ram_type: 'DDR5', ram_slots: 4 },
          category: { slug: 'motherboards' },
        }),
      ],
      llmText: 'The socket mismatch blocks this combination.',
    });

    const response = await service.compare({ productIds: [ID_A, ID_B] });

    expect(response.compatibility.compatible).toBe(false);
    expect(response.compatibility.issues.map((issue) => issue.rule)).toContain('cpu-socket');
    const sent = llm.calls[0]?.messages[0]?.content ?? '';
    expect(sent).toContain('compatible: false');
  });

  it('404s for non-ACTIVE products without calling retrieval or the LLM', async () => {
    // Only one of the two ids resolves as ACTIVE: the other is missing.
    const { service, searchMock, llm } = buildService({ rows: [row(ID_A)] });

    await expect(service.compare({ productIds: [ID_A, ID_B] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(searchMock).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
  });

  it('regenerates once when the summary mentions a foreign product', async () => {
    const { service, llm } = buildService({
      llmQueue: [`Consider ${FOREIGN_ID} instead.`, 'A and B compared fairly.'],
    });

    const response = await service.compare({ productIds: [ID_A, ID_B] });

    expect(llm.calls).toHaveLength(2);
    expect(response.summary).toContain('fairly');
    expect(response.summary).not.toContain(FOREIGN_ID);
  });

  it('falls back to a deterministic summary when validation keeps failing', async () => {
    const { service, llm } = buildService({
      llmQueue: [`Buy ${FOREIGN_ID}.`, `Really buy ${FOREIGN_ID}.`],
    });

    const response = await service.compare({ productIds: [ID_A, ID_B] });

    expect(llm.calls).toHaveLength(2);
    expect(response.summary).not.toContain(FOREIGN_ID);
    // Deterministic fallback names the compared products from SQL data.
    expect(response.summary).toContain('Product 1111');
    expect(response.summary).toContain('Product 2222');
  });

  it('summarizes from the table alone when retrieval fails', async () => {
    const { service, llm } = buildService({ retrievalFails: true, llmText: 'A vs B summary.' });

    const response = await service.compare({ productIds: [ID_A, ID_B] });

    expect(response.summary).toBe('A vs B summary.');
    expect(response.citations).toEqual([]);
    expect(llm.calls).toHaveLength(1);
  });
});

describe('buildDeterministicSummary (pure)', () => {
  it('lists SQL products in both locales', () => {
    const products: ComparableProduct[] = [
      { id: 'a', name: 'A', slug: 'a', priceAmount: 1, currency: 'USD', specs: { ram_gb: 8 } },
    ];

    expect(buildDeterministicSummary(products, [], 'en').text).toContain('Comparing 1');
    expect(buildDeterministicSummary(products, [], 'es').text).toContain('Comparativa de 1');
  });
});

describe('compare prompt (versioned source)', () => {
  it('loads the v1 markdown and renders the locale', () => {
    const template = loadCompareSystemPrompt();

    expect(template).toContain('{{locale}}');
    expect(template).toContain('COMPARISON TABLE');
    expect(template).toContain('COMPATIBILITY RESULT');
    expect(template).toContain('untrusted');

    const rendered = renderCompareSystemPrompt(template, 'es');
    expect(rendered).toContain('es');
    expect(rendered).not.toContain('{{locale}}');
  });

  it('builds a user message with table, verdict, use case and chunks', () => {
    const message = buildCompareUserMessage({
      products: [
        { id: ID_A, name: 'A', slug: 'a', priceAmount: 100_00, currency: 'USD', specs: {} },
      ],
      table: buildComparisonTable([
        { id: ID_A, name: 'A', slug: 'a', priceAmount: 100_00, currency: 'USD', specs: {} },
      ]),
      compatibility: { compatible: true, issues: [] },
      hits: [hit('a', ID_A, 0.05)],
      useCase: 'gaming',
    });

    expect(message).toContain('COMPARISON TABLE');
    expect(message).toContain('10000 USD');
    expect(message).toContain('compatible: true');
    expect(message).toContain('USE CASE: gaming');
    expect(message).toContain('--- chunk [1]');
  });
});
