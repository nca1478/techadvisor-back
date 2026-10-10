import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from '../src/modules/ai/adapters/fake-llm.adapter.js';
import { EMBEDDING_PROVIDER } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from '../src/modules/ai/interfaces/llm-provider.interface.js';
import { EmbeddingStateService } from '../src/modules/reindex/embedding-state.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Product comparison (e2e, see ADR 0035).
 *
 * Boots the full app with the OFFLINE fake embedding adapter and a scripted
 * fake LLM (no provider calls): three ACTIVE laptops (two with RAM/storage
 * specs, one without specs) plus one DRAFT laptop (must 404), each ACTIVE
 * product carrying one indexed chunk. The scripted summary echoes SQL
 * figures so the test pins that summary figures match the table.
 */

const DIMENSIONS = 1536;

interface Fixture {
  app: INestApplication;
  prisma: PrismaService;
  llm: FakeLlmAdapter;
  suffix: string;
  brandId: string;
  categoryId: string;
  productAId: string;
  productBId: string;
  productCId: string;
  draftProductId: string;
  documentIds: string[];
  chunkIds: string[];
}

async function addChunk(
  prisma: PrismaService,
  documentId: string,
  productId: string | null,
  ord: number,
  content: string,
  vector: number[],
): Promise<string> {
  const client = prisma as unknown as PrismaClient;
  const chunk = await client.chunk.create({
    data: {
      documentId,
      productId,
      ord,
      content,
      locale: 'en',
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
  return chunk.id;
}

async function createProduct(
  client: PrismaClient,
  brandId: string,
  categoryId: string,
  suffix: string,
  tag: string,
  overrides: {
    priceAmount: number;
    specs: Record<string, number | string | boolean>;
    status?: 'ACTIVE' | 'DRAFT';
  },
): Promise<string> {
  const product = await client.product.create({
    data: {
      sku: `E2E-COMPARE-${tag}-${suffix}`,
      name: `Compare Laptop ${tag} ${suffix}`,
      slug: `e2e-compare-laptop-${tag.toLowerCase()}-${suffix}`,
      description: `Laptop ${tag} for comparison tests.`,
      brandId,
      categoryId,
      priceAmount: overrides.priceAmount,
      currency: 'USD',
      status: overrides.status ?? 'ACTIVE',
      specs: overrides.specs,
    },
  });
  await client.inventory.create({ data: { productId: product.id, stock: 5, reserved: 0 } });
  return product.id;
}

describe('Advisor compare (e2e)', () => {
  const suffix = `c-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let fixture: Fixture;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    const llm = new FakeLlmAdapter({
      defaultText:
        'Laptop B offers 32 GB of RAM and 1024 GB of storage at 8000 minor units [1], while laptop A offers 16 GB at 10000 minor units [2].',
    });
    const stateStub = {
      getScope: () =>
        Promise.resolve({
          model: 'fake-hash-v1',
          dimensions: DIMENSIONS,
          column: 'embedding',
          cast: 'vector' as const,
          embed: (texts: string[]) => fake.embed(texts),
        }),
    };
    const ctx = await createTestApp([
      { token: EMBEDDING_PROVIDER, useValue: fake },
      { token: EmbeddingStateService, useValue: stateStub },
      { token: LLM_PROVIDER, useValue: llm },
      { token: APP_CONFIG, useValue: { ...parseEnv() } },
    ]);
    const app = ctx.app;
    const prisma = ctx.module.get(PrismaService);
    const client = prisma as unknown as PrismaClient;

    const brand = await client.brand.create({
      data: { name: `E2E Compare Brand ${suffix}`, slug: `e2e-compare-brand-${suffix}` },
    });
    const category = await client.category.create({
      data: { name: `Laptops ${suffix}`, slug: `e2e-compare-laptops-${suffix}` },
    });

    const productAId = await createProduct(client, brand.id, category.id, suffix, 'A', {
      priceAmount: 100_00,
      specs: { ram_gb: 16, storage_gb: 512 },
    });
    const productBId = await createProduct(client, brand.id, category.id, suffix, 'B', {
      priceAmount: 80_00,
      specs: { ram_gb: 32, storage_gb: 1024 },
    });
    const productCId = await createProduct(client, brand.id, category.id, suffix, 'C', {
      priceAmount: 90_00,
      specs: {},
    });
    const draftProductId = await createProduct(client, brand.id, category.id, suffix, 'D', {
      priceAmount: 70_00,
      specs: { ram_gb: 64 },
      status: 'DRAFT',
    });

    const contents = [
      'Laptop A review: comfortable keyboard and 16 GB of RAM for everyday study.',
      'Laptop B review: powerful machine with 32 GB of RAM for demanding study workloads.',
      'Laptop C review: balanced everyday laptop without detailed specifications.',
    ];
    const vectors = await fake.embed(contents);
    const vectorAt = (index: number): number[] => {
      const vector = vectors.at(index);
      if (vector === undefined) {
        throw new Error(`Missing fixture vector at ${String(index)}`);
      }
      return vector;
    };

    const documentIds: string[] = [];
    const chunkIds: string[] = [];
    const productIds = [productAId, productBId, productCId];
    for (const [index, productId] of productIds.entries()) {
      const doc = await client.document.create({
        data: {
          productId,
          type: 'SPEC_SHEET',
          title: `E2E compare doc ${suffix} ${String(index)}`,
          locale: 'en',
          source: `test:compare-${suffix}-${String(index)}`,
          contentHash: `hash-compare-${suffix}-${String(index)}`,
          status: 'READY',
        },
      });
      documentIds.push(doc.id);
      chunkIds.push(
        await addChunk(prisma, doc.id, productId, 0, contents[index] ?? '', vectorAt(index)),
      );
    }

    fixture = {
      app,
      prisma,
      llm,
      suffix,
      brandId: brand.id,
      categoryId: category.id,
      productAId,
      productBId,
      productCId,
      draftProductId,
      documentIds,
      chunkIds,
    };
  }, 60_000);

  afterAll(async () => {
    const client = fixture.prisma as unknown as PrismaClient;
    await client.document.deleteMany({ where: { id: { in: fixture.documentIds } } });
    await client.product.deleteMany({
      where: {
        id: {
          in: [fixture.productAId, fixture.productBId, fixture.productCId, fixture.draftProductId],
        },
      },
    });
    await client.brand.deleteMany({ where: { id: fixture.brandId } });
    await client.category.deleteMany({ where: { id: fixture.categoryId } });
    await fixture.app.close();
  });

  it('compares 2 products: SQL table with best highlights + cited summary', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/compare')
      .send({ productIds: [fixture.productAId, fixture.productBId], useCase: 'studying' })
      .expect(200);

    const body = res.body as {
      products: { productId: string; priceAmount: number; currency: string }[];
      table: { key: string; values: unknown[]; best: number[]; direction: string | null }[];
      compatibility: { compatible: boolean; issues: unknown[] };
      summary: string;
      citations: { n: number; chunkId: string }[];
    };

    expect(body.products.map((product) => product.productId)).toEqual([
      fixture.productAId,
      fixture.productBId,
    ]);
    // Price figures come from SQL: 100_00 vs 80_00, cheapest highlighted.
    const price = body.table.find((row) => row.key === 'price_amount');
    expect(price).toMatchObject({ values: [10000, 8000], best: [1], direction: 'lower' });
    const ram = body.table.find((row) => row.key === 'ram_gb');
    expect(ram).toMatchObject({ values: [16, 32], best: [1], direction: 'higher' });
    // Two laptops: no component-pair rules apply.
    expect(body.compatibility.compatible).toBe(true);
    // The summary echoes the table figures with citations into the evidence.
    expect(body.summary).toContain('32 GB');
    expect(body.summary).toContain('[1]');
    expect(body.citations.length).toBeGreaterThan(0);
    for (const citation of body.citations) {
      expect(fixture.chunkIds).toContain(citation.chunkId);
    }
  });

  it('compares 3 products with missing specs (null cells, no best)', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/compare')
      .send({ productIds: [fixture.productAId, fixture.productBId, fixture.productCId] })
      .expect(200);

    const body = res.body as {
      products: unknown[];
      table: { key: string; values: unknown[]; best: number[]; direction: string | null }[];
    };

    expect(body.products).toHaveLength(3);
    const ram = body.table.find((row) => row.key === 'ram_gb');
    expect(ram).toMatchObject({ values: [16, 32, null], best: [], direction: null });
  });

  it('404s for draft products without calling the LLM', async () => {
    const callsBefore = fixture.llm.calls.length;
    await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/compare')
      .send({ productIds: [fixture.productAId, fixture.draftProductId] })
      .expect(404);
    expect(fixture.llm.calls).toHaveLength(callsBefore);
  });

  it('validates productIds, useCase and locale', async () => {
    const server = fixture.app.getHttpServer();
    const valid = [fixture.productAId, fixture.productBId];
    await request(server)
      .post('/api/v1/advisor/compare')
      .send({ productIds: [valid[0]] })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/compare')
      .send({ productIds: [...valid, fixture.productCId, fixture.draftProductId] })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/compare')
      .send({ productIds: [valid[0], valid[0]] })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/compare')
      .send({ productIds: ['not-a-uuid', valid[1]] })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/compare')
      .send({ productIds: valid, useCase: 'x'.repeat(501) })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/compare')
      .send({ productIds: valid, locale: 'not-a-locale!' })
      .expect(400);
  });
});
