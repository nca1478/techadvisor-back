import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { AiProviderError } from '../src/modules/ai/ai-provider.error.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { EMBEDDING_PROVIDER } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Public semantic search (e2e, see ADR 0022).
 *
 * Boots the full app with the OFFLINE fake embedding adapter (no provider
 * calls): fixtures are one ACTIVE headphone product whose chunk matches a
 * natural-language query without literal overlap, one unrelated ACTIVE
 * product, and one ARCHIVED product whose chunk must never surface.
 */

const DIMENSIONS = 1536;
const QUERY = 'audífonos livianos para usar muchas horas';

describe('Search endpoint (e2e)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let app: INestApplication;
  let prisma: PrismaService;
  const documentIds: string[] = [];
  let brandId = '';
  let categoryId = '';
  let headphoneId = '';
  let keyboardId = '';

  async function addChunk(
    documentId: string,
    productId: string,
    ord: number,
    content: string,
    locale: string,
    vector: number[],
  ): Promise<void> {
    const client = prisma as unknown as PrismaClient;
    const chunk = await client.chunk.create({
      data: {
        documentId,
        productId,
        ord,
        content,
        locale,
        metadata: { docType: 'SPEC_SHEET' },
        embeddingModel: 'fake-hash-v1',
        embeddingDim: DIMENSIONS,
      },
    });
    await client.$executeRaw`
      UPDATE "chunks"
      SET "embedding" = ${`[${vector.join(',')}]`}::vector
      WHERE "id" = ${chunk.id}::uuid
    `;
  }

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    const ctx = await createTestApp([{ token: EMBEDDING_PROVIDER, useValue: fake }]);
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const client = prisma as unknown as PrismaClient;

    const brand = await client.brand.create({
      data: { name: `E2E Search Brand ${suffix}`, slug: `e2e-search-brand-${suffix}` },
    });
    brandId = brand.id;
    const category = await client.category.create({
      data: { name: `Audio ${suffix}`, slug: `e2e-search-audio-${suffix}` },
    });
    categoryId = category.id;
    const otherCategory = await client.category.create({
      data: { name: `PC ${suffix}`, slug: `e2e-search-pc-${suffix}` },
    });

    const headphones = await client.product.create({
      data: {
        sku: `E2E-SEARCH-HP-${suffix}`,
        name: `Auriculares Ligeros ${suffix}`,
        slug: `e2e-search-headphones-${suffix}`,
        description: 'Auriculares cómodos para el día a día.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    headphoneId = headphones.id;
    await client.productImage.create({
      data: { productId: headphones.id, url: 'https://cdn.example.com/hp.jpg', position: 0 },
    });
    await client.inventory.create({ data: { productId: headphones.id, stock: 5, reserved: 0 } });

    const keyboard = await client.product.create({
      data: {
        sku: `E2E-SEARCH-KB-${suffix}`,
        name: `Teclado Mecánico ${suffix}`,
        slug: `e2e-search-keyboard-${suffix}`,
        description: 'Teclado con interruptores táctiles.',
        brandId: brand.id,
        categoryId: otherCategory.id,
        priceAmount: 200_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    keyboardId = keyboard.id;
    await client.inventory.create({ data: { productId: keyboard.id, stock: 3, reserved: 0 } });

    const archived = await client.product.create({
      data: {
        sku: `E2E-SEARCH-AR-${suffix}`,
        name: `Auriculares Viejos ${suffix}`,
        slug: `e2e-search-archived-${suffix}`,
        description: 'Modelo descatalogado.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 10_00,
        currency: 'USD',
        status: 'ARCHIVED',
        specs: {},
      },
    });

    const contents = [
      // Matches QUERY via full-text (all stems present) without being a
      // literal copy. Carries a decoy price ("999") that must NEVER leak
      // into the response — price always comes from SQL (100_00).
      'Estos audífonos son livianos y cómodos para usar durante muchas horas de trabajo. Dicen que cuestan 999 dólares, pero ese dato es solo texto.',
      'Teclado mecánico con interruptores táctiles y retroiluminación para programar.',
      'Estos audífonos livianos son ideales para usar muchas horas seguidas.',
    ];
    const vectors = await fake.embed(contents);

    const docHeadphones = await client.document.create({
      data: {
        productId: headphones.id,
        type: 'SPEC_SHEET',
        title: `E2E search doc hp ${suffix}`,
        locale: 'es',
        source: `test:search-${suffix}-hp`,
        contentHash: `hash-search-${suffix}-hp`,
        status: 'READY',
      },
    });
    const docKeyboard = await client.document.create({
      data: {
        productId: keyboard.id,
        type: 'SPEC_SHEET',
        title: `E2E search doc kb ${suffix}`,
        locale: 'es',
        source: `test:search-${suffix}-kb`,
        contentHash: `hash-search-${suffix}-kb`,
        status: 'READY',
      },
    });
    const docArchived = await client.document.create({
      data: {
        productId: archived.id,
        type: 'SPEC_SHEET',
        title: `E2E search doc ar ${suffix}`,
        locale: 'es',
        source: `test:search-${suffix}-ar`,
        contentHash: `hash-search-${suffix}-ar`,
        status: 'READY',
      },
    });
    documentIds.push(docHeadphones.id, docKeyboard.id, docArchived.id);

    const vectorAt = (index: number): number[] => {
      const vector = vectors.at(index);
      if (vector === undefined) {
        throw new Error(`Missing fixture vector at ${String(index)}`);
      }
      return vector;
    };
    await addChunk(docHeadphones.id, headphones.id, 0, contents[0] ?? '', 'es', vectorAt(0));
    await addChunk(docKeyboard.id, keyboard.id, 0, contents[1] ?? '', 'es', vectorAt(1));
    await addChunk(docArchived.id, archived.id, 0, contents[2] ?? '', 'es', vectorAt(2));
  }, 60_000);

  afterAll(async () => {
    const client = prisma as unknown as PrismaClient;
    await client.document.deleteMany({ where: { id: { in: documentIds } } });
    await client.product.deleteMany({ where: { id: { in: [headphoneId, keyboardId] } } });
    await client.product.deleteMany({ where: { sku: { startsWith: `E2E-SEARCH-AR-${suffix}` } } });
    await client.brand.deleteMany({ where: { id: brandId } });
    await client.category.deleteMany({ where: { id: categoryId } });
    await client.category.deleteMany({ where: { slug: `e2e-search-pc-${suffix}` } });
    await app.close();
  });

  it('returns the relevant headphones first for a natural-language query', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: QUERY, locale: 'es' })
      .expect(200);

    const body = res.body as {
      query: string;
      degraded: boolean;
      locale: string;
      currency: string;
      results: { product: { id: string; priceAmount: number }; score: number; snippet: string }[];
    };
    expect(body.query).toBe(QUERY);
    expect(body.degraded).toBe(false);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]?.product.id).toBe(headphoneId);
    // Price comes from SQL (100_00), never from the chunk decoy ("999").
    expect(body.results[0]?.product.priceAmount).toBe(100_00);
    expect(typeof body.results[0]?.snippet).toBe('string');
  });

  it('excludes archived products even when their chunks match', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: QUERY, locale: 'es', limit: 24 })
      .expect(200);

    const body = res.body as { results: { product: { slug: string } }[] };
    for (const result of body.results) {
      expect(result.product.slug).not.toContain('archived');
    }
  });

  it('filters by category slug and maxPrice', async () => {
    const byCategory = (
      await request(app.getHttpServer())
        .get('/api/v1/search')
        .query({ q: QUERY, category: `e2e-search-audio-${suffix}` })
        .expect(200)
    ).body as { results: { product: { id: string } }[] };
    expect(byCategory.results.map((result) => result.product.id)).toContain(headphoneId);
    expect(byCategory.results.map((result) => result.product.id)).not.toContain(keyboardId);

    const byPrice = (
      await request(app.getHttpServer())
        .get('/api/v1/search')
        .query({ q: QUERY, maxPrice: 150_00 })
        .expect(200)
    ).body as { results: { product: { id: string } }[] };
    expect(byPrice.results.map((result) => result.product.id)).toContain(headphoneId);
    expect(byPrice.results.map((result) => result.product.id)).not.toContain(keyboardId);

    const unknownCategory = (
      await request(app.getHttpServer())
        .get('/api/v1/search')
        .query({ q: QUERY, category: 'does-not-exist' })
        .expect(200)
    ).body as { results: unknown[] };
    expect(unknownCategory.results).toEqual([]);
  });

  it('validates q and currency', async () => {
    await request(app.getHttpServer()).get('/api/v1/search').expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: 'x'.repeat(201) })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: QUERY, currency: 'ARS' })
      .expect(400);
  });
});

describe('Search degraded mode (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const failing = {
      model: 'fake-hash-v1',
      dimensions: DIMENSIONS,
      embed: (): Promise<number[][]> =>
        Promise.reject(new AiProviderError('server', 'provider down', 'fake')),
    };
    const ctx = await createTestApp([{ token: EMBEDDING_PROVIDER, useValue: failing }]);
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers with full-text only and degraded: true when embeddings fail', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: QUERY, locale: 'es' })
      .expect(200);

    const body = res.body as { degraded: boolean; results: unknown[] };
    expect(body.degraded).toBe(true);
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe('Search rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    const config = { ...parseEnv(), SEARCH_RATE_LIMIT_MAX: 2, SEARCH_RATE_LIMIT_TTL_MS: 60000 };
    const ctx = await createTestApp([
      { token: EMBEDDING_PROVIDER, useValue: fake },
      { token: APP_CONFIG, useValue: config },
    ]);
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 after exceeding the search rate limit', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/search').query({ q: 'laptop' }).expect(200);
    await request(server).get('/api/v1/search').query({ q: 'laptop' }).expect(200);
    await request(server).get('/api/v1/search').query({ q: 'laptop' }).expect(429);
  });
});
