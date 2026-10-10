import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
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
 * Buying-advisor recommendations (e2e, see ADR 0032).
 *
 * Boots the full app with offline fakes (no provider calls): two ACTIVE
 * in-stock laptops under 800 USD (with indexed Spanish chunks), one
 * out-of-stock laptop, one ARCHIVED laptop and one laptop over budget.
 * The scripted LLM first returns the purchase intent JSON (budgets come from
 * the deterministic parser, not the model) and then the recommendation
 * draft JSON. Assertions tolerate foreign `laptops` rows from parallel
 * suites: every returned product must satisfy the constraints, and the
 * fixture ids must be included (excluded where they violate them).
 */

const DIMENSIONS = 1536;
const MODEL = 'fake-hash-v1';

interface RecommendBody {
  message: string;
  products: {
    productId: string;
    name: string;
    slug: string;
    priceAmount: number;
    currency: string;
    inStock: boolean;
    availableQuantity: number;
    imageUrl: string | null;
    reason: string;
    citations: { n: number; documentId: string; chunkId: string; title: string; snippet: string }[];
  }[];
  clarifyingQuestion?: string;
}

function intentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    categorySlug: 'laptops',
    useCases: ['estudiar ingeniería'],
    mustHaveSpecs: {},
    brandsInclude: [],
    brandsExclude: [],
    missingInfo: [],
    ...overrides,
  });
}

function draftJson(
  text: string,
  items: { productId: string; reason: string; citations?: number[] }[],
): string {
  return JSON.stringify({
    text,
    items: items.map((item) => ({ citations: [1], ...item })),
  });
}

describe('Advisor recommendations (e2e)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let app: INestApplication;
  let prisma: PrismaService;
  let llm: FakeLlmAdapter;

  let brandId = '';
  let categoryId = '';
  const documentIds: string[] = [];
  const sessionIds: string[] = [];
  const productIds: Record<string, string> = {};

  async function addChunk(
    documentId: string,
    productId: string,
    ord: number,
    content: string,
    vector: number[],
  ): Promise<void> {
    const client = prisma as unknown as PrismaClient;
    const chunk = await client.chunk.create({
      data: {
        documentId,
        productId,
        ord,
        content,
        locale: 'es',
        metadata: { docType: 'SPEC_SHEET' },
        embeddingModel: MODEL,
        embeddingDim: DIMENSIONS,
      },
    });
    await client.$executeRaw`
      UPDATE "chunks"
      SET "embedding" = ${`[${vector.join(',')}]`}::vector
      WHERE "id" = ${chunk.id}::uuid
    `;
  }

  async function createProduct(options: {
    key: string;
    name: string;
    priceAmount: number;
    status: 'ACTIVE' | 'ARCHIVED';
    stock: number;
    specs: Prisma.InputJsonValue;
    chunkContent?: string;
    vector?: number[];
  }): Promise<void> {
    const client = prisma as unknown as PrismaClient;
    const product = await client.product.create({
      data: {
        sku: `E2E-REC-${options.key}-${suffix}`.toUpperCase(),
        name: options.name,
        slug: `e2e-rec-${options.key}-${suffix}`,
        description: `${options.name} para pruebas del asesor.`,
        brandId,
        categoryId,
        priceAmount: options.priceAmount,
        currency: 'USD',
        status: options.status,
        specs: options.specs,
      },
    });
    await client.inventory.create({
      data: { productId: product.id, stock: options.stock, reserved: 0 },
    });
    productIds[options.key] = product.id;
    if (options.chunkContent !== undefined && options.vector !== undefined) {
      const doc = await client.document.create({
        data: {
          productId: product.id,
          type: 'SPEC_SHEET',
          title: `E2E rec doc ${options.key} ${suffix}`,
          locale: 'es',
          source: `test:recommend-${suffix}-${options.key}`,
          contentHash: `hash-rec-${suffix}-${options.key}`,
          status: 'READY',
        },
      });
      documentIds.push(doc.id);
      await addChunk(doc.id, product.id, 0, options.chunkContent, options.vector);
    }
  }

  beforeAll(async () => {
    const fakeEmbeddings = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    llm = new FakeLlmAdapter({ defaultText: 'unused' });
    const ctx = await createTestApp([
      { token: EMBEDDING_PROVIDER, useValue: fakeEmbeddings },
      {
        token: EmbeddingStateService,
        useValue: {
          getScope: () =>
            Promise.resolve({
              model: MODEL,
              dimensions: DIMENSIONS,
              column: 'embedding',
              cast: 'vector' as const,
              embed: (texts: string[]) => fakeEmbeddings.embed(texts),
            }),
        },
      },
      { token: LLM_PROVIDER, useValue: llm },
      {
        token: APP_CONFIG,
        useValue: { ...parseEnv(), ADVISOR_RATE_LIMIT_MAX: 1000, ADVISOR_ABSTAIN_MIN_SCORE: 0 },
      },
    ]);
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const client = prisma as unknown as PrismaClient;

    const brand = await client.brand.create({
      data: { name: `E2E Rec Brand ${suffix}`, slug: `e2e-rec-brand-${suffix}` },
    });
    brandId = brand.id;
    // Shared `laptops` category (also used by the catalog suite): find or
    // create, and never delete it here — other suites may own it.
    const existing = await client.category.findUnique({ where: { slug: 'laptops' } });
    categoryId =
      existing?.id ??
      (await client.category.create({ data: { name: 'Laptops', slug: 'laptops' } })).id;

    const vectors = await fakeEmbeddings.embed([
      'Este portátil es ideal para estudiar ingeniería: 16 GB de memoria RAM y 512 GB NVMe.',
      'Portátil para estudiar ingeniería con 32 GB de memoria RAM y pantalla amplia.',
    ]);
    const vectorAt = (index: number): number[] => {
      const vector = vectors.at(index);
      if (vector === undefined) {
        throw new Error(`Missing fixture vector at ${String(index)}`);
      }
      return vector;
    };

    await createProduct({
      key: 'a',
      name: `Portátil Rec A ${suffix}`,
      priceAmount: 700_00,
      status: 'ACTIVE',
      stock: 5,
      specs: { ram_gb: 16, storage_gb: 512, storage_type: 'NVME' },
      chunkContent:
        'Este portátil es ideal para estudiar ingeniería: 16 GB de memoria RAM y 512 GB NVMe.',
      vector: vectorAt(0),
    });
    await createProduct({
      key: 'b',
      name: `Portátil Rec B ${suffix}`,
      priceAmount: 750_00,
      status: 'ACTIVE',
      stock: 3,
      specs: { ram_gb: 32, storage_gb: 1000, storage_type: 'NVME' },
      chunkContent: 'Portátil para estudiar ingeniería con 32 GB de memoria RAM y pantalla amplia.',
      vector: vectorAt(1),
    });
    await createProduct({
      key: 'out',
      name: `Portátil Rec Agotado ${suffix}`,
      priceAmount: 600_00,
      status: 'ACTIVE',
      stock: 0,
      specs: { ram_gb: 8 },
    });
    await createProduct({
      key: 'arch',
      name: `Portátil Rec Archivado ${suffix}`,
      priceAmount: 500_00,
      status: 'ARCHIVED',
      stock: 10,
      specs: { ram_gb: 16 },
    });
    await createProduct({
      key: 'expensive',
      name: `Portátil Rec Caro ${suffix}`,
      priceAmount: 1200_00,
      status: 'ACTIVE',
      stock: 5,
      specs: { ram_gb: 64 },
    });
  }, 60_000);

  afterAll(async () => {
    const client = prisma as unknown as PrismaClient;
    if (sessionIds.length > 0) {
      await client.chatMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await client.chatSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
    await client.unansweredQuery.deleteMany({ where: { sessionId: { in: sessionIds } } });
    if (documentIds.length > 0) {
      await client.document.deleteMany({ where: { id: { in: documentIds } } });
    }
    const ids = Object.values(productIds);
    if (ids.length > 0) {
      await client.product.deleteMany({ where: { id: { in: ids } } });
    }
    if (brandId !== '') {
      await client.brand.deleteMany({ where: { id: brandId } });
    }
    await app.close();
  });

  async function createGuestSession() {
    const agent = request.agent(app.getHttpServer());
    const created = await agent.post('/api/v1/advisor/sessions').expect(201);
    const sessionId = (created.body as { id: string }).id;
    sessionIds.push(sessionId);
    return { agent, sessionId };
  }

  function queueIntentAndDraft(text: string, aReason: string, bReason: string): void {
    llm.enqueueTexts([
      intentJson(),
      draftJson(text, [
        { productId: productIds['a'] ?? '', reason: aReason },
        { productId: productIds['b'] ?? '', reason: bReason },
      ]),
    ]);
  }

  it('recommends real in-stock laptops within budget in Spanish (acceptance)', async () => {
    const { agent, sessionId } = await createGuestSession();
    queueIntentAndDraft(
      'Estas opciones encajan con tus estudios de ingeniería [1].',
      '16 GB de RAM para tus clases',
      '32 GB de RAM para proyectos exigentes',
    );

    const res = await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ content: 'portátil para estudiar ingeniería, máx. 800 USD', locale: 'es' })
      .expect(200);
    const body = res.body as RecommendBody;

    const ids = body.products.map((card) => card.productId);
    // Fixtures that satisfy the constraints are included…
    expect(ids).toContain(productIds['a']);
    expect(ids).toContain(productIds['b']);
    // …violators never appear…
    expect(ids).not.toContain(productIds['out']);
    expect(ids).not.toContain(productIds['arch']);
    expect(ids).not.toContain(productIds['expensive']);
    // …every returned product satisfies the constraints from SQL data…
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.products.length).toBeLessThanOrEqual(8);
    for (const card of body.products) {
      expect(card.currency).toBe('USD');
      expect(card.priceAmount).toBeLessThanOrEqual(800_00);
      expect(card.inStock).toBe(true);
      expect(typeof card.name).toBe('string');
      expect(typeof card.reason).toBe('string');
      expect(Array.isArray(card.citations)).toBe(true);
    }
    // …and the message carries no price or stock figures from the LLM.
    expect(body.message).toContain('[1]');
    expect(body.message).not.toMatch(/\$\s?\d/);
    expect(body.clarifyingQuestion).toBeUndefined();
  });

  it('recommends the same set in English (acceptance)', async () => {
    const { agent, sessionId } = await createGuestSession();
    llm.enqueueTexts([
      intentJson({ useCases: ['study engineering'] }),
      draftJson('These options fit your engineering studies [1].', [
        { productId: productIds['a'] ?? '', reason: '16 GB of RAM for your classes' },
        { productId: productIds['b'] ?? '', reason: '32 GB of RAM for heavy projects' },
      ]),
    ]);

    const res = await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ content: 'laptop for studying engineering, under $800', locale: 'en' })
      .expect(200);
    const body = res.body as RecommendBody;

    const ids = body.products.map((card) => card.productId);
    expect(ids).toContain(productIds['a']);
    expect(ids).toContain(productIds['b']);
    expect(ids).not.toContain(productIds['out']);
    expect(ids).not.toContain(productIds['arch']);
    expect(ids).not.toContain(productIds['expensive']);
    for (const card of body.products) {
      expect(card.priceAmount).toBeLessThanOrEqual(800_00);
      expect(card.inStock).toBe(true);
    }
  });

  it('asks a clarification question when budget and category are missing', async () => {
    const { agent, sessionId } = await createGuestSession();
    llm.enqueueTexts([
      intentJson({
        categorySlug: undefined,
        useCases: [],
        missingInfo: ['budget', 'category', 'use'],
      }),
    ]);

    const res = await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ content: 'hola, quiero algo bueno para la universidad', locale: 'es' })
      .expect(200);
    const body = res.body as RecommendBody;

    expect(body.products).toEqual([]);
    expect(body.clarifyingQuestion).toContain('presupuesto');
    expect(body.message).toBe(body.clarifyingQuestion);
  });

  it('explains which constraint to relax when nothing matches the budget', async () => {
    const { agent, sessionId } = await createGuestSession();
    llm.enqueueTexts([intentJson()]);

    const res = await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ content: 'portátil para estudiar ingeniería por menos de $10', locale: 'es' })
      .expect(200);
    const body = res.body as RecommendBody;

    expect(body.products).toEqual([]);
    expect(body.message.toLowerCase()).toContain('presupuesto');
    expect(body.clarifyingQuestion).toBeUndefined();

    const client = prisma as unknown as PrismaClient;
    const rows = await client.unansweredQuery.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productId: null, reason: 'no_candidates' });
  });

  it('streams validated text and products over SSE', async () => {
    const { agent, sessionId } = await createGuestSession();
    queueIntentAndDraft('Estas opciones encajan [1].', '16 GB de RAM', '32 GB de RAM');

    const res = await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .set('Accept', 'text/event-stream')
      .send({ content: 'portátil para estudiar ingeniería, máx. 800 USD', locale: 'es' })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const text = res.text;
    expect(text).toContain('event: delta');
    expect(text).toContain('event: products');
    expect(text).toContain('event: done');
    // Products travel validated at the end of the stream.
    const productsEvent = text.split('event: products')[1]?.split('event:')[0] ?? '';
    expect(productsEvent).toContain(productIds['a'] ?? '');
    expect(productsEvent).not.toContain(productIds['out'] ?? 'no-such-id-out');
    expect(productsEvent).not.toContain(productIds['arch'] ?? 'no-such-id-arch');
  });

  it('keeps the legacy role+content append working (201)', async () => {
    const { agent, sessionId } = await createGuestSession();

    const res = await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ role: 'USER', content: 'hello' })
      .expect(201);
    expect(res.body).toMatchObject({ role: 'USER', content: 'hello' });
  });

  it('validates the body shape and rejects foreign sessions', async () => {
    const { agent, sessionId } = await createGuestSession();
    const other = request.agent(app.getHttpServer());

    await agent.post(`/api/v1/advisor/sessions/${sessionId}/messages`).send({}).expect(400);
    await agent
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ content: '   ' })
      .expect(400);
    await other
      .post(`/api/v1/advisor/sessions/${sessionId}/messages`)
      .send({ content: 'portátil barato' })
      .expect(404);
  });
});
