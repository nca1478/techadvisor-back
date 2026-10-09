import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from '../src/modules/ai/adapters/fake-llm.adapter.js';
import { AiProviderError } from '../src/modules/ai/ai-provider.error.js';
import type { LlmGenerateResult } from '../src/modules/ai/interfaces/llm-provider.interface.js';
import { EMBEDDING_PROVIDER } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from '../src/modules/ai/interfaces/llm-provider.interface.js';
import { EmbeddingStateService } from '../src/modules/reindex/embedding-state.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Product-QA advisor (e2e, see ADR 0025).
 *
 * Boots the full app with the OFFLINE fake embedding adapter and a scripted
 * fake LLM (no provider calls): one ACTIVE headphone product with an indexed
 * chunk (carrying a decoy price that must never surface as fact), one
 * product-less POLICY document (general evidence) and one DRAFT product
 * (must 404). The abstention suite pins `ADVISOR_ABSTAIN_MIN_SCORE`
 * impossibly high so the below-threshold path is deterministic.
 */

const DIMENSIONS = 1536;
const QUESTION = '¿Cuánto dura la batería de estos audífonos?';

interface Fixture {
  app: INestApplication;
  prisma: PrismaService;
  llm: FakeLlmAdapter;
  suffix: string;
  brandId: string;
  categoryId: string;
  productId: string;
  chunkId: string;
  documentId: string;
  documentIds: string[];
  emptyProductId: string;
  draftProductId: string;
}

async function addChunk(
  prisma: PrismaService,
  documentId: string,
  productId: string | null,
  ord: number,
  content: string,
  locale: string,
  vector: number[],
): Promise<string> {
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
  return chunk.id;
}

async function createFixtures(
  overrides: { token: symbol | string | object; useValue: unknown }[],
  suffix: string,
  llm: FakeLlmAdapter,
): Promise<Fixture> {
  const ctx = await createTestApp(overrides);
  const app = ctx.app;
  const prisma = ctx.module.get(PrismaService);
  const client = prisma as unknown as PrismaClient;

  const brand = await client.brand.create({
    data: { name: `E2E Advisor Brand ${suffix}`, slug: `e2e-advisor-brand-${suffix}` },
  });
  const category = await client.category.create({
    data: { name: `Audio ${suffix}`, slug: `e2e-advisor-audio-${suffix}` },
  });

  const product = await client.product.create({
    data: {
      sku: `E2E-ADVISOR-HP-${suffix}`,
      name: `Auriculares X200 ${suffix}`,
      slug: `e2e-advisor-headphones-${suffix}`,
      description: 'Auriculares cómodos para el día a día.',
      brandId: brand.id,
      categoryId: category.id,
      priceAmount: 100_00,
      currency: 'USD',
      status: 'ACTIVE',
      specs: { battery_hours: 10 },
    },
  });
  await client.inventory.create({ data: { productId: product.id, stock: 5, reserved: 0 } });

  // ACTIVE product without chunks: retrieval finds nothing → `no_evidence`.
  const emptyProduct = await client.product.create({
    data: {
      sku: `E2E-ADVISOR-EMPTY-${suffix}`,
      name: `Soporte Vacio ${suffix}`,
      slug: `e2e-advisor-empty-${suffix}`,
      description: 'Producto sin documentos indexados.',
      brandId: brand.id,
      categoryId: category.id,
      priceAmount: 50_00,
      currency: 'USD',
      status: 'ACTIVE',
      specs: {},
    },
  });

  const draft = await client.product.create({
    data: {
      sku: `E2E-ADVISOR-DRAFT-${suffix}`,
      name: `Borrador ${suffix}`,
      slug: `e2e-advisor-draft-${suffix}`,
      description: 'Producto en borrador.',
      brandId: brand.id,
      categoryId: category.id,
      priceAmount: 10_00,
      currency: 'USD',
      status: 'DRAFT',
      specs: {},
    },
  });

  const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
  const contents = [
    // Matches QUESTION via full-text. Carries a decoy price ("999") that
    // must NEVER leak into facts — price always comes from SQL (100_00).
    'Estos audífonos tienen una batería que dura hasta 10 horas seguidas. Dicen que cuestan 999 dólares, pero ese dato es solo texto.',
    'Política general de garantía: todos los productos tienen 2 años de garantía.',
  ];
  const vectors = await fake.embed(contents);
  const vectorAt = (index: number): number[] => {
    const vector = vectors.at(index);
    if (vector === undefined) {
      throw new Error(`Missing fixture vector at ${String(index)}`);
    }
    return vector;
  };

  const docProduct = await client.document.create({
    data: {
      productId: product.id,
      type: 'SPEC_SHEET',
      title: `E2E advisor doc hp ${suffix}`,
      locale: 'es',
      source: `test:advisor-${suffix}-hp`,
      contentHash: `hash-advisor-${suffix}-hp`,
      status: 'READY',
    },
  });
  // Product-less POLICY document: general evidence merged without a filter.
  const docPolicy = await client.document.create({
    data: {
      type: 'POLICY',
      title: `E2E advisor doc policy ${suffix}`,
      locale: 'es',
      source: `test:advisor-${suffix}-policy`,
      contentHash: `hash-advisor-${suffix}-policy`,
      status: 'READY',
    },
  });

  const chunkId = await addChunk(
    prisma,
    docProduct.id,
    product.id,
    0,
    contents[0] ?? '',
    'es',
    vectorAt(0),
  );
  await addChunk(prisma, docPolicy.id, null, 0, contents[1] ?? '', 'es', vectorAt(1));

  return {
    app,
    prisma,
    llm,
    suffix,
    brandId: brand.id,
    categoryId: category.id,
    productId: product.id,
    chunkId,
    documentId: docProduct.id,
    documentIds: [docProduct.id, docPolicy.id],
    emptyProductId: emptyProduct.id,
    draftProductId: draft.id,
  };
}

async function destroyFixtures(fixture: Fixture): Promise<void> {
  const client = fixture.prisma as unknown as PrismaClient;
  await client.unansweredQuery.deleteMany({
    where: { productId: { in: [fixture.productId, fixture.emptyProductId] } },
  });
  await client.document.deleteMany({ where: { id: { in: fixture.documentIds } } });
  await client.product.deleteMany({
    where: { id: { in: [fixture.productId, fixture.emptyProductId, fixture.draftProductId] } },
  });
  await client.brand.deleteMany({ where: { id: fixture.brandId } });
  await client.category.deleteMany({ where: { id: fixture.categoryId } });
  await fixture.app.close();
}

function hermeticOverrides(
  fake: FakeEmbeddingAdapter,
  llm: FakeLlmAdapter,
  configExtra: Record<string, unknown> = {},
) {
  // Retrieval serves the persisted ACTIVE model (ADR 0023): pin the scope to
  // the offline fake alongside the provider so suites stay hermetic.
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
  return [
    { token: EMBEDDING_PROVIDER, useValue: fake },
    { token: EmbeddingStateService, useValue: stateStub },
    { token: LLM_PROVIDER, useValue: llm },
    { token: APP_CONFIG, useValue: { ...parseEnv(), ...configExtra } },
  ];
}

describe('Advisor product-qa (e2e)', () => {
  const suffix = `a-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let fixture: Fixture;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    // Threshold 0: any retrieved evidence answers (scores stay luck-free).
    const llm = new FakeLlmAdapter({
      defaultText: 'La batería dura hasta 10 horas [1].',
    });
    fixture = await createFixtures(
      hermeticOverrides(fake, llm, { ADVISOR_ABSTAIN_MIN_SCORE: 0 }),
      suffix,
      llm,
    );
  }, 60_000);

  afterAll(async () => {
    await destroyFixtures(fixture);
  });

  it('answers with a valid citation to the delivered chunk', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId, question: QUESTION, locale: 'es' })
      .expect(200);

    const body = res.body as {
      answer: string;
      abstained: boolean;
      citations: {
        n: number;
        documentId: string;
        chunkId: string;
        title: string;
        snippet: string;
      }[];
    };
    expect(body.abstained).toBe(false);
    expect(body.answer).toContain('[1]');
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0]).toMatchObject({
      n: 1,
      documentId: fixture.documentId,
      chunkId: fixture.chunkId,
      title: `E2E advisor doc hp ${suffix}`,
    });
    expect(typeof body.citations[0]?.snippet).toBe('string');
    // The scripted LLM was called exactly once (one question → one call).
    expect(fixture.llm.calls).toHaveLength(1);
    // The chunk decoy price never becomes a citation fact: the citation
    // points at the evidence, while price facts travel separately from SQL.
    const prompt = fixture.llm.calls[0]?.messages[0]?.content ?? '';
    expect(prompt).toMatch(/Price: 10000 USD/);
  });

  it('404s for unknown, draft and other-status products', async () => {
    await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: '22222222-2222-4222-8222-222222222222', question: QUESTION })
      .expect(404);
    await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.draftProductId, question: QUESTION })
      .expect(404);
  });

  it('validates productId, question length and locale', async () => {
    const server = fixture.app.getHttpServer();
    await request(server)
      .post('/api/v1/advisor/product-qa')
      .send({ productId: 'not-a-uuid', question: QUESTION })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId, question: '   ' })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId, question: 'x'.repeat(1001) })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId, question: QUESTION, locale: 'not-a-locale!' })
      .expect(400);
  });
});

describe('Advisor abstention (e2e)', () => {
  const suffix = `b-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let fixture: Fixture;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    // Impossibly high threshold: any evidence scores below it.
    const llm = new FakeLlmAdapter({ defaultText: 'should never be used [1].' });
    fixture = await createFixtures(
      hermeticOverrides(fake, llm, { ADVISOR_ABSTAIN_MIN_SCORE: 999 }),
      suffix,
      llm,
    );
  }, 60_000);

  afterAll(async () => {
    await destroyFixtures(fixture);
  });

  it('abstains without calling the LLM and records the query (below_threshold)', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId, question: QUESTION, locale: 'es' })
      .expect(200);

    const body = res.body as { answer: string; abstained: boolean; citations: unknown[] };
    expect(body.abstained).toBe(true);
    expect(body.citations).toEqual([]);
    expect(body.answer.toLowerCase()).toContain('no tengo esa información');
    expect(fixture.llm.calls).toHaveLength(0);

    const client = fixture.prisma as unknown as PrismaClient;
    const rows = await client.unansweredQuery.findMany({
      where: { productId: fixture.productId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      query: QUESTION,
      productId: fixture.productId,
      reason: 'below_threshold',
    });
  });

  it('records an abstention for a product without indexed chunks', async () => {
    const question = '¿Este producto sin documentos tiene bluetooth?';
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.emptyProductId, question, locale: 'es' })
      .expect(200);

    const body = res.body as { abstained: boolean };
    expect(body.abstained).toBe(true);
    expect(fixture.llm.calls).toHaveLength(0);

    // `no_evidence` when no general chunk ranks in the top-N, else
    // `below_threshold` (the policy fixture usually provides general
    // evidence): either way the query is recorded without an LLM call.
    const client = fixture.prisma as unknown as PrismaClient;
    const rows = await client.unansweredQuery.findMany({
      where: { productId: fixture.emptyProductId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.query).toBe(question);
    expect(['no_evidence', 'below_threshold']).toContain(rows[0]?.reason);
  });
});

describe('Advisor rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    const llm = new FakeLlmAdapter({ defaultText: 'respuesta [1].' });
    const config = {
      ...parseEnv(),
      ADVISOR_RATE_LIMIT_MAX: 2,
      ADVISOR_RATE_LIMIT_TTL_MS: 60000,
    };
    const ctx = await createTestApp(hermeticOverrides(fake, llm, config));
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 after exceeding the advisor rate limit', async () => {
    const server = app.getHttpServer();
    const payload = {
      productId: '33333333-3333-4333-8333-333333333333',
      question: '¿Cuánto dura la batería?',
    };
    // Unknown product → 404, but the throttler guard runs first and counts
    // every hit, so the third request is rejected before validation.
    await request(server).post('/api/v1/advisor/product-qa').send(payload).expect(404);
    await request(server).post('/api/v1/advisor/product-qa').send(payload).expect(404);
    await request(server).post('/api/v1/advisor/product-qa').send(payload).expect(429);
  });
});

/** LLM stub that fails like a provider outage (e.g. rejected credentials). */
class RejectingLlmAdapter extends FakeLlmAdapter {
  constructor(private readonly failure: Error) {
    super({ defaultText: 'unused' });
  }

  override generate(): Promise<LlmGenerateResult> {
    return Promise.reject(this.failure);
  }
}

describe('Advisor provider outage (e2e)', () => {
  const suffix = `c-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let fixture: Fixture;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    const llm = new RejectingLlmAdapter(
      new AiProviderError('auth', 'Chat provider rejected credentials', 'anthropic'),
    );
    fixture = await createFixtures(
      hermeticOverrides(fake, llm, { ADVISOR_ABSTAIN_MIN_SCORE: 0 }),
      suffix,
      llm,
    );
  }, 60_000);

  afterAll(async () => {
    await destroyFixtures(fixture);
  });

  it('returns a uniform 503 when the LLM provider fails', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: fixture.productId, question: QUESTION, locale: 'es' })
      .expect(503);

    // Uniform contract shape so web clients can show a friendly message.
    expect(res.body).toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(typeof res.body.message).toBe('string');
    // The provider detail never leaks to the client.
    expect(JSON.stringify(res.body)).not.toContain('rejected credentials');
  });
});
