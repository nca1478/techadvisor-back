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
 * Post-sale support advisor (e2e, see ADR 0036).
 *
 * Boots the full app with the OFFLINE fake embedding adapter and a scripted
 * fake LLM (no provider calls): one POLICY document (warranty template text)
 * and one FAQ document as indexed evidence, plus two users where the second
 * owns an order. The abstention suite pins `ADVISOR_ABSTAIN_MIN_SCORE`
 * impossibly high so the below-threshold path is deterministic.
 */

const DIMENSIONS = 1536;
const QUESTION = '¿Cuánto dura la garantía de un portátil?';

interface Fixture {
  app: INestApplication;
  prisma: PrismaService;
  llm: FakeLlmAdapter;
  suffix: string;
  brandId: string;
  categoryId: string;
  policyDocumentId: string;
  faqDocumentId: string;
  documentIds: string[];
  chunkIds: string[];
  userId: string;
  token: string;
  otherUserId: string;
  otherToken: string;
  orderId: string;
}

async function addChunk(
  prisma: PrismaService,
  documentId: string,
  ord: number,
  content: string,
  locale: string,
  vector: number[],
): Promise<string> {
  const client = prisma as unknown as PrismaClient;
  const chunk = await client.chunk.create({
    data: {
      documentId,
      productId: null,
      ord,
      content,
      locale,
      metadata: { docType: 'POLICY' },
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

async function registerUser(
  app: INestApplication,
  email: string,
): Promise<{ userId: string; token: string }> {
  const registered = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: 'long-enough-password' })
    .expect(201);
  const body = registered.body as { user: { id: string }; tokens: { accessToken: string } };
  return { userId: body.user.id, token: body.tokens.accessToken };
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
    data: { name: `E2E Support Brand ${suffix}`, slug: `e2e-support-brand-${suffix}` },
  });
  const category = await client.category.create({
    data: { name: `Laptops ${suffix}`, slug: `e2e-support-laptops-${suffix}` },
  });

  const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
  const contents = [
    'PLANTILLA A REVISAR POR EL NEGOCIO. Política de garantía: los portátiles tienen 2 años de garantía desde la entrega.',
    'PLANTILLA A REVISAR POR EL NEGOCIO. Política de devoluciones: 30 días naturales para devolver un producto sin usar.',
  ];
  const vectors = await fake.embed(contents);
  const vectorAt = (index: number): number[] => {
    const vector = vectors.at(index);
    if (vector === undefined) {
      throw new Error(`Missing fixture vector at ${String(index)}`);
    }
    return vector;
  };

  const docPolicy = await client.document.create({
    data: {
      type: 'POLICY',
      title: `E2E support warranty ${suffix}`,
      locale: 'es',
      source: `test:support-${suffix}-warranty`,
      contentHash: `hash-support-${suffix}-warranty`,
      status: 'READY',
    },
  });
  const docFaq = await client.document.create({
    data: {
      type: 'FAQ',
      title: `E2E support returns faq ${suffix}`,
      locale: 'es',
      source: `test:support-${suffix}-faq`,
      contentHash: `hash-support-${suffix}-faq`,
      status: 'READY',
    },
  });

  const chunkIds = [
    await addChunk(prisma, docPolicy.id, 0, contents[0] ?? '', 'es', vectorAt(0)),
    await addChunk(prisma, docFaq.id, 0, contents[1] ?? '', 'es', vectorAt(1)),
  ];

  const first = await registerUser(app, `e2e-support-${suffix}@example.com`);
  const second = await registerUser(app, `e2e-support-other-${suffix}@example.com`);

  const product = await client.product.create({
    data: {
      sku: `E2E-SUPPORT-P-${suffix}`,
      name: `Portátil Fixture ${suffix}`,
      slug: `e2e-support-laptop-${suffix}`,
      description: 'Portátil de prueba para la orden de soporte.',
      brandId: brand.id,
      categoryId: category.id,
      priceAmount: 100_00,
      currency: 'USD',
      status: 'ACTIVE',
      specs: {},
    },
  });
  const order = await client.order.create({
    data: {
      userId: second.userId,
      status: 'PAID',
      currency: 'USD',
      totalAmount: 200_00,
      shipping: { fullName: 'Soporte Prueba', line1: 'Calle 1', city: 'Madrid', country: 'ES' },
      items: { create: [{ productId: product.id, qty: 2, unitPriceAmount: 100_00 }] },
    },
  });

  return {
    app,
    prisma,
    llm,
    suffix,
    brandId: brand.id,
    categoryId: category.id,
    policyDocumentId: docPolicy.id,
    faqDocumentId: docFaq.id,
    documentIds: [docPolicy.id, docFaq.id],
    chunkIds,
    userId: first.userId,
    token: first.token,
    otherUserId: second.userId,
    otherToken: second.token,
    orderId: order.id,
  };
}

async function destroyFixtures(fixture: Fixture): Promise<void> {
  const client = fixture.prisma as unknown as PrismaClient;
  await client.unansweredQuery.deleteMany({ where: { query: { contains: fixture.suffix } } });
  await client.unansweredQuery.deleteMany({ where: { query: QUESTION } });
  await client.order.deleteMany({
    where: { userId: { in: [fixture.userId, fixture.otherUserId] } },
  });
  await client.product.deleteMany({ where: { sku: { contains: fixture.suffix } } });
  await client.document.deleteMany({ where: { id: { in: fixture.documentIds } } });
  await client.brand.deleteMany({ where: { id: fixture.brandId } });
  await client.category.deleteMany({ where: { id: fixture.categoryId } });
  await client.user.deleteMany({
    where: { id: { in: [fixture.userId, fixture.otherUserId] } },
  });
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

describe('Advisor support (e2e)', () => {
  const suffix = `a-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let fixture: Fixture;

  beforeAll(async () => {
    const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    // Threshold 0: any retrieved evidence answers (scores stay luck-free).
    const llm = new FakeLlmAdapter({
      defaultText: 'Los portátiles tienen 2 años de garantía [1].',
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

  it('answers the warranty question with a citation to the loaded policy', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/support')
      .send({ question: QUESTION, locale: 'es' })
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
    // Either loaded policy document is a valid citation target: ranking
    // between the two POLICY/FAQ chunks is a retrieval detail, while the
    // contract (cited answer from the loaded policies) is what matters here.
    expect(body.citations[0]).toMatchObject({ n: 1 });
    expect(fixture.documentIds).toContain(body.citations[0]?.documentId);
    expect(typeof body.citations[0]?.snippet).toBe('string');
    expect(fixture.llm.calls).toHaveLength(1);
  });

  it('grounds order-scoped answers in SQL facts for the owning user', async () => {
    const before = fixture.llm.calls.length;
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/support')
      .set('Authorization', `Bearer ${fixture.otherToken}`)
      .send({ question: '¿Cuál es el estado de mi pedido?', orderId: fixture.orderId })
      .expect(200);

    const body = res.body as { abstained: boolean };
    expect(body.abstained).toBe(false);
    expect(fixture.llm.calls.length).toBe(before + 1);
    const prompt = fixture.llm.calls.at(-1)?.messages[0]?.content ?? '';
    // Structured SQL facts travel to the prompt; no PII (address/email).
    expect(prompt).toContain('ORDER FACTS');
    expect(prompt).toMatch(/Status: PAID/);
    expect(prompt).toMatch(/Total: 20000 USD/);
    expect(prompt).not.toContain('Soporte Prueba');
    expect(prompt).not.toContain('@');
  });

  it('404s for other users’ orders exactly like unknown ids', async () => {
    await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/support')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ question: '¿Cuál es el estado de mi pedido?', orderId: fixture.orderId })
      .expect(404);
    await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/support')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({
        question: '¿Cuál es el estado de mi pedido?',
        orderId: '77777777-7777-4777-8777-777777777777',
      })
      .expect(404);
  });

  it('401s anonymous callers asking about an order', async () => {
    await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/support')
      .send({ question: '¿Cuál es el estado de mi pedido?', orderId: fixture.orderId })
      .expect(401);
  });

  it('validates question length, orderId and locale', async () => {
    const server = fixture.app.getHttpServer();
    await request(server).post('/api/v1/advisor/support').send({ question: '   ' }).expect(400);
    await request(server)
      .post('/api/v1/advisor/support')
      .send({ question: 'x'.repeat(1001) })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/support')
      .send({ question: QUESTION, orderId: 'not-a-uuid' })
      .expect(400);
    await request(server)
      .post('/api/v1/advisor/support')
      .send({ question: QUESTION, locale: 'not-a-locale!' })
      .expect(400);
    await request(server).post('/api/v1/advisor/support').send({}).expect(400);
  });
});

describe('Advisor support abstention (e2e)', () => {
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

  it('abstains without calling the LLM, derives to a human and records the query', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/advisor/support')
      .send({ question: QUESTION, locale: 'es' })
      .expect(200);

    const body = res.body as { answer: string; abstained: boolean; citations: unknown[] };
    expect(body.abstained).toBe(true);
    expect(body.citations).toEqual([]);
    expect(body.answer.toLowerCase()).toContain('equipo humano');
    expect(fixture.llm.calls).toHaveLength(0);

    const client = fixture.prisma as unknown as PrismaClient;
    const rows = await client.unansweredQuery.findMany({ where: { query: QUESTION } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      query: QUESTION,
      productId: null,
      reason: 'below_threshold',
    });
  });
});
