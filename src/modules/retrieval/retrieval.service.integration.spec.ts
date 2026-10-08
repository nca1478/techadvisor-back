import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeEmbeddingAdapter } from '../ai/adapters/fake-embedding.adapter.js';
import { RetrievalService } from './retrieval.service.js';

/**
 * Hybrid retrieval against the real PostgreSQL (see ADR 0021).
 *
 * Requires the Docker Compose database with migrations applied
 * (`docker compose up -d && npx prisma migrate deploy`). Uses the OFFLINE
 * fake adapter only — no provider calls, no secrets, no Redis.
 *
 * Proves the task acceptance criteria:
 * - a query with an exact SKU returns the matching READY chunk first
 *   (full-text boost beats the random fake-hash vector order);
 * - hard filters by product and document type are respected;
 * - chunks of non-READY documents, soft-deleted documents, and
 *   non-ACTIVE products are never returned;
 * - chunks embedded with another model are never mixed into vector search.
 */

const DIMENSIONS = 1536;
const SKU = 'AURORA-X9000';

describe('RetrievalService hybrid search (integration)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let prisma: PrismaClient;
  let service: RetrievalService;
  const documentIds: string[] = [];
  const chunkIds: Record<string, string> = {};
  let productActiveId = '';
  let productOtherId = '';
  let staleModelChunkId = '';

  async function addChunk(
    documentId: string,
    productId: string | null,
    ord: number,
    content: string,
    locale: string,
    vectors: Map<string, number[]>,
    key: string,
  ): Promise<void> {
    const chunk = await prisma.chunk.create({
      data: {
        documentId,
        // Ingestion denormalizes the document product onto every chunk.
        productId,
        ord,
        content,
        locale,
        metadata: { docType: 'MANUAL' },
        embeddingModel: 'fake-hash-v1',
        embeddingDim: DIMENSIONS,
      },
    });
    const vector = vectors.get(key);
    if (vector === undefined) {
      throw new Error(`Missing fixture vector for ${key}`);
    }
    await prisma.$executeRaw`
      UPDATE "chunks"
      SET "embedding" = ${`[${vector.join(',')}]`}::vector
      WHERE "id" = ${chunk.id}::uuid
    `;
    chunkIds[key] = chunk.id;
  }

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Start the Compose database before running DB tests.',
      );
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const embeddings = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
    service = new RetrievalService(prisma as unknown as PrismaService, embeddings);

    const brand = await prisma.brand.create({
      data: { name: `Ret Brand ${suffix}`, slug: `ret-brand-${suffix}` },
    });
    const category = await prisma.category.create({
      data: { name: `Ret Cat ${suffix}`, slug: `ret-cat-${suffix}` },
    });
    const makeProduct = (tag: string, status: 'ACTIVE' | 'ARCHIVED'): Promise<{ id: string }> =>
      prisma.product.create({
        data: {
          sku: `RET-${suffix}-${tag}`,
          name: `Ret Product ${suffix} ${tag}`,
          slug: `ret-product-${suffix}-${tag}`,
          description: 'Retrieval fixture product.',
          brandId: brand.id,
          categoryId: category.id,
          priceAmount: 100_00,
          currency: 'USD',
          status,
          specs: {},
        },
      });
    const active = await makeProduct('active', 'ACTIVE');
    const other = await makeProduct('other', 'ACTIVE');
    const archived = await makeProduct('archived', 'ARCHIVED');
    productActiveId = active.id;
    productOtherId = other.id;

    const makeDocument = (
      tag: string,
      overrides: Record<string, unknown> = {},
    ): Promise<{ id: string }> =>
      prisma.document.create({
        data: {
          type: 'MANUAL',
          title: `Ret doc ${suffix} ${tag}`,
          locale: 'en',
          // Unique per fixture: [productId, source] is unique (auto SPEC_SHEET
          // hook aside, one product owns many manual documents in tests).
          source: `test:ret-${suffix}-${tag}`,
          contentHash: `hash-${suffix}-${tag}`,
          status: 'READY',
          ...overrides,
        },
      });
    const docManual = await makeDocument('manual', { productId: active.id });
    const docFaq = await makeDocument('faq', { productId: other.id, type: 'FAQ' });
    const docEs = await makeDocument('es', { productId: active.id, type: 'FAQ', locale: 'es' });
    const docPending = await makeDocument('pending', { productId: active.id, status: 'PENDING' });
    const docDeleted = await makeDocument('deleted', {
      productId: active.id,
      type: 'WARRANTY',
      deletedAt: new Date(),
    });
    const docArchived = await makeDocument('archived', { productId: archived.id });
    const docStale = await makeDocument('stale', { productId: active.id });
    for (const doc of [docManual, docFaq, docEs, docPending, docDeleted, docArchived, docStale]) {
      documentIds.push(doc.id);
    }

    const contents: Record<string, string> = {
      sku: `The ${SKU} laptop features 16 GB of RAM and an eight-core processor for engineering students.`,
      faq: 'Frequently asked questions about the office desktop lineup and widescreen monitors.',
      es: 'Preguntas frecuentes sobre la garantía extendida del portátil para estudiantes.',
      pending: `Draft manual for the ${SKU} with unfinished specifications and placeholder text.`,
      deleted: `Warranty terms for the ${SKU} extended coverage plan and return policy details.`,
      archived: `Manual for the ${SKU} legacy edition, discontinued last year and unsupported.`,
      stale: 'General computing tips about keyboards, displays and ergonomic accessories.',
    };
    const vectors = new Map<string, number[]>();
    const embedded = await embeddings.embed(Object.values(contents));
    Object.keys(contents).forEach((key, index) => {
      const vector = embedded.at(index);
      if (vector !== undefined) {
        vectors.set(key, vector);
      }
    });
    await addChunk(docManual.id, active.id, 0, contents['sku'] ?? '', 'en', vectors, 'sku');
    await addChunk(docFaq.id, other.id, 0, contents['faq'] ?? '', 'en', vectors, 'faq');
    await addChunk(docEs.id, active.id, 0, contents['es'] ?? '', 'es', vectors, 'es');
    await addChunk(
      docPending.id,
      active.id,
      0,
      contents['pending'] ?? '',
      'en',
      vectors,
      'pending',
    );
    await addChunk(
      docDeleted.id,
      active.id,
      0,
      contents['deleted'] ?? '',
      'en',
      vectors,
      'deleted',
    );
    await addChunk(
      docArchived.id,
      archived.id,
      0,
      contents['archived'] ?? '',
      'en',
      vectors,
      'archived',
    );

    // Chunk stored with another embedding model: vector search must ignore it.
    const stale = await prisma.chunk.create({
      data: {
        documentId: docStale.id,
        productId: active.id,
        ord: 0,
        content: contents['stale'] ?? '',
        locale: 'en',
        metadata: { docType: 'MANUAL' },
        embeddingModel: 'other-model-v1',
        embeddingDim: DIMENSIONS,
      },
    });
    const staleVector = vectors.get('stale');
    if (staleVector === undefined) {
      throw new Error('Missing fixture vector for stale');
    }
    await prisma.$executeRaw`
      UPDATE "chunks"
      SET "embedding" = ${`[${staleVector.join(',')}]`}::vector
      WHERE "id" = ${stale.id}::uuid
    `;
    staleModelChunkId = stale.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { id: { in: documentIds } } });
    await prisma.product.deleteMany({
      where: { id: { in: [productActiveId, productOtherId] } },
    });
    await prisma.product.deleteMany({ where: { sku: { startsWith: `RET-${suffix}-` } } });
    await prisma.brand.deleteMany({ where: { slug: `ret-brand-${suffix}` } });
    await prisma.category.deleteMany({ where: { slug: `ret-cat-${suffix}` } });
    await prisma.$disconnect();
  });

  it('returns the exact-SKU chunk first', async () => {
    // Query is the bare SKU: plainto_tsquery ANDs every term, so extra words
    // would demand the chunk contain them too.
    const hits = await service.search({ query: SKU, topN: 10 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkId).toBe(chunkIds['sku']);
    expect(hits[0]?.source).toMatchObject({ docType: 'MANUAL' });
  });

  it('never returns chunks of non-READY, deleted, or archived-product documents', async () => {
    const hits = await service.search({ query: `${SKU} complete guide`, topN: 50 });
    const ids = hits.map((hit) => hit.chunkId);

    expect(ids).toContain(chunkIds['sku']);
    expect(ids).not.toContain(chunkIds['pending']);
    expect(ids).not.toContain(chunkIds['deleted']);
    expect(ids).not.toContain(chunkIds['archived']);
  });

  it('never mixes chunks embedded with another model into vector search', async () => {
    // The stale chunk matches these words best, yet it must stay out: its
    // vector belongs to another model and both branches scope to the active
    // one. The faq chunk is untouched by the query words but must surface via
    // the vector branch (cosine always ranks every in-scope chunk).
    const hits = await service.search({ query: 'keyboards displays ergonomic', topN: 50 });
    const ids = hits.map((hit) => hit.chunkId);

    expect(ids).not.toContain(staleModelChunkId);
    expect(ids).toContain(chunkIds['faq']);
  });

  it('respects the productId filter', async () => {
    const hits = await service.search({
      query: 'laptop for engineering students',
      filters: { productId: productOtherId },
      topN: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.productId).toBe(productOtherId);
    }
    expect(hits.map((hit) => hit.chunkId)).not.toContain(chunkIds['sku']);
  });

  it('respects the docTypes filter', async () => {
    const hits = await service.search({
      query: 'office desktop questions',
      filters: { docTypes: ['FAQ'] },
      topN: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.source.docType).toBe('FAQ');
    }
    expect(hits.map((hit) => hit.chunkId)).not.toContain(chunkIds['sku']);
  });

  it('respects the locales filter with the matching text configuration', async () => {
    const hits = await service.search({
      query: 'garantía portátil',
      filters: { locales: ['es'] },
      topN: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.locale).toBe('es');
    }
    expect(hits[0]?.chunkId).toBe(chunkIds['es']);
  });

  it('returns nothing when the active model indexed no chunks (never mixes)', async () => {
    const other = new FakeEmbeddingAdapter({ model: 'future-model-v9', dimensions: DIMENSIONS });
    const future = new RetrievalService(prisma as unknown as PrismaService, other);

    // Every fixture chunk is `fake-hash-v1`: a query under another model must
    // come back empty rather than compare across models. (During a real model
    // switch retrieval keeps using the previous model until reindexing ends.)
    await expect(future.search({ query: `${SKU} specifications`, topN: 10 })).resolves.toEqual([]);
  });
});
