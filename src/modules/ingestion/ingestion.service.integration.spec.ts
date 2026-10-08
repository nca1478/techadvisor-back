import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { parseEnv } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeEmbeddingAdapter } from '../ai/adapters/fake-embedding.adapter.js';
import { AiProviderError } from '../ai/ai-provider.error.js';
import { DocumentExtractorService } from './document-extractor.service.js';
import { IngestionService, resolveEmbeddingColumn } from './ingestion.service.js';
import type { IngestionQueue } from './ingestion.queue.js';

/**
 * Full ingestion pipeline against the real PostgreSQL (see ADR 0019).
 *
 * Requires the Docker Compose database with migrations applied
 * (`docker compose up -d && npx prisma migrate deploy`). Uses the OFFLINE
 * fake adapter only — no provider calls, no secrets, no Redis (the queue is
 * stubbed; BullMQ retries are configured, not reimplemented, and covered by
 * `ingestion.queue.spec.ts`).
 *
 * Proves the task acceptance criteria:
 * - ingesting the same document twice leaves the same chunk count and never
 *   calls the provider again (idempotency via `content_hash`);
 * - changed content replaces chunks transactionally (no duplicates, no
 *   chunkless window on failure);
 * - a provider failure leaves the document FAILED with a legible error and
 *   the pipeline recovers on retry.
 */

const DIMENSIONS = 1536;

function buildManual(length: number, seed: string): string {
  const sections = ['# Overview', '# Specifications', '# Warranty'];
  const paragraph = `${seed} technical paragraph about ports, power draw, firmware updates and compatibility notes. `;
  const parts: string[] = [];
  for (const heading of sections) {
    parts.push(heading, '');
    while (parts.join('\n').length < length / sections.length + parts.length) {
      parts.push(paragraph.repeat(8).trim(), '');
    }
  }
  parts.push('| Spec | Value |', '| --- | --- |', '| ram_gb | 16 |', '| socket | AM5 |', '');
  return parts.join('\n');
}

describe('IngestionService pipeline (integration)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let prisma: PrismaClient;
  let service: IngestionService;
  let embedSpy: ReturnType<typeof vi.spyOn>;
  const fake = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });
  const documentIds: string[] = [];
  let productId = '';

  async function createDocument(title: string): Promise<string> {
    const document = await prisma.document.create({
      data: {
        type: 'MANUAL',
        title: `${title} ${suffix}`,
        locale: 'en',
        contentHash: `pending-${suffix}-${String(documentIds.length)}`,
        status: 'PENDING',
      },
    });
    documentIds.push(document.id);
    return document.id;
  }

  const chunkCount = (documentId: string): Promise<number> =>
    prisma.chunk.count({ where: { documentId } });

  const embeddedCount = async (documentId: string): Promise<number> => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM "chunks"
      WHERE "document_id" = ${documentId}::uuid AND embedding IS NOT NULL
    `;
    return Number(rows[0]?.count ?? 0);
  };

  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Start the Compose database before running DB tests.',
      );
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    embedSpy = vi.spyOn(fake, 'embed');
    service = new IngestionService(
      prisma as unknown as PrismaService,
      fake,
      new DocumentExtractorService(),
      parseEnv(),
      null,
    );
  }, 30_000);

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { id: { in: documentIds } } });
    if (productId !== '') {
      await prisma.product.deleteMany({ where: { id: productId } });
      await prisma.brand.deleteMany({ where: { slug: `ing-brand-${suffix}` } });
      await prisma.category.deleteMany({ where: { slug: `ing-cat-${suffix}` } });
    }
    await prisma.$disconnect();
  });

  it('ingests a document: READY with embedded chunks and metadata', async () => {
    const documentId = await createDocument('Pipeline manual');
    const raw = Buffer.from(buildManual(6000, 'alpha'), 'utf8');

    const result = await service.ingestDocument(documentId, raw, 'text/markdown');

    expect(result).toMatchObject({ documentId, status: 'READY' });
    expect(result.chunks).toBeGreaterThan(1);
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe('READY');
    expect(document.error).toBeNull();
    expect(document.contentHash).toHaveLength(64);
    expect(await chunkCount(documentId)).toBe(result.chunks);
    expect(await embeddedCount(documentId)).toBe(result.chunks);

    const chunks = await prisma.chunk.findMany({
      where: { documentId },
      orderBy: { ord: 'asc' },
    });
    expect(chunks[0]?.ord).toBe(0);
    expect(chunks[0]?.embeddingModel).toBe('fake-hash-v1');
    expect(chunks[0]?.embeddingDim).toBe(DIMENSIONS);
    const metadata = chunks[0]?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      productId: null,
      categoryId: null,
      docType: 'MANUAL',
      title: expect.stringContaining('Pipeline manual'),
    });
    expect(typeof metadata['section']).toBe('number');
  });

  it('re-ingesting unchanged content skips without calling the provider', async () => {
    const documentId = await createDocument('Idempotent manual');
    const raw = Buffer.from(buildManual(6000, 'beta'), 'utf8');

    const first = await service.ingestDocument(documentId, raw, 'text/markdown');
    expect(first.status).toBe('READY');
    embedSpy.mockClear();

    const second = await service.ingestDocument(documentId, raw, 'text/markdown');

    expect(second).toEqual({ documentId, status: 'SKIPPED', chunks: first.chunks });
    expect(embedSpy).not.toHaveBeenCalled();
    expect(await chunkCount(documentId)).toBe(first.chunks);
  });

  it('replaces chunks transactionally when content changes', async () => {
    const documentId = await createDocument('Evolving manual');
    const v1 = Buffer.from(buildManual(6000, 'gamma'), 'utf8');
    const v2 = Buffer.from(`${buildManual(3000, 'delta')}\n\n# Appendix\n\nExtra section.`, 'utf8');

    const first = await service.ingestDocument(documentId, v1, 'text/markdown');
    const hashV1 = (await prisma.document.findUniqueOrThrow({ where: { id: documentId } }))
      .contentHash;
    const second = await service.ingestDocument(documentId, v2, 'text/markdown');

    expect(second.status).toBe('READY');
    expect(await chunkCount(documentId)).toBe(second.chunks);
    expect(await embeddedCount(documentId)).toBe(second.chunks);
    const hashV2 = (await prisma.document.findUniqueOrThrow({ where: { id: documentId } }))
      .contentHash;
    expect(hashV2).not.toBe(hashV1);
    expect(first.chunks).toBeGreaterThan(0);
  });

  it('keeps old chunks when the replacement fails, then recovers', async () => {
    const documentId = await createDocument('Flaky manual');
    const v1 = Buffer.from(buildManual(5000, 'epsilon'), 'utf8');
    const v2 = Buffer.from(buildManual(5000, 'zeta'), 'utf8');

    const first = await service.ingestDocument(documentId, v1, 'text/markdown');
    expect(first.status).toBe('READY');

    const failing = {
      model: 'fake-hash-v1',
      dimensions: DIMENSIONS,
      embed: vi.fn().mockRejectedValue(new AiProviderError('server', 'boom', 'fake')),
    };
    const failingService = new IngestionService(
      prisma as unknown as PrismaService,
      failing,
      new DocumentExtractorService(),
      parseEnv(),
      null,
    );
    await expect(failingService.ingestDocument(documentId, v2, 'text/markdown')).rejects.toThrow(
      /boom/,
    );

    const failed = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('boom');
    // Rollback: the previous chunks are intact, the document is retryable.
    expect(await chunkCount(documentId)).toBe(first.chunks);

    const recovered = await service.ingestDocument(documentId, v2, 'text/markdown');
    expect(recovered.status).toBe('READY');
    expect(await chunkCount(documentId)).toBe(recovered.chunks);
  });

  it('propagates product metadata into chunks', async () => {
    const brand = await prisma.brand.create({
      data: { name: `Ing Brand ${suffix}`, slug: `ing-brand-${suffix}` },
    });
    const category = await prisma.category.create({
      data: { name: `Ing Cat ${suffix}`, slug: `ing-cat-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        sku: `ING-${suffix}`,
        name: `Ing Product ${suffix}`,
        slug: `ing-product-${suffix}`,
        description: 'Integration fixture product.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    productId = product.id;
    const document = await prisma.document.create({
      data: {
        productId: product.id,
        categoryId: category.id,
        type: 'SPEC_SHEET',
        title: `Spec sheet ${suffix}`,
        locale: 'en',
        contentHash: `pending-meta-${suffix}`,
        status: 'PENDING',
      },
    });
    documentIds.push(document.id);

    await service.ingestDocument(
      document.id,
      Buffer.from('# Specs\n\nGreat product with 16 GB of RAM.', 'utf8'),
      'text/markdown',
    );
    const chunk = await prisma.chunk.findFirstOrThrow({ where: { documentId: document.id } });
    expect(chunk.metadata).toMatchObject({
      productId: product.id,
      categoryId: category.id,
      docType: 'SPEC_SHEET',
    });
  });

  it('retries FAILED documents and rejects retries of non-FAILED ones', async () => {
    const documentId = await createDocument('Retry manual');
    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const queued = new IngestionService(
      prisma as unknown as PrismaService,
      fake,
      new DocumentExtractorService(),
      parseEnv(),
      {
        add: vi.fn((name: string, data: unknown, opts: unknown) => {
          added.push({ name, data, opts });
          return Promise.resolve({ id: 'job-1' });
        }),
      } as unknown as IngestionQueue,
    );
    // Not FAILED yet: retry refuses.
    await expect(queued.retryDocument(documentId, Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /Only FAILED/,
    );

    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'FAILED', error: 'boom' },
    });
    const result = await queued.retryDocument(
      documentId,
      Buffer.from('# Retry\n\nContent here.', 'utf8'),
      'text/markdown',
    );
    expect(result).toEqual({ enqueued: true });
    const back = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(back.status).toBe('PENDING');
    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe('ingest-document');
    expect(added[0]?.opts).toMatchObject({
      attempts: 5,
      jobId: `ingestion:${documentId}`,
    });
  });

  it('enqueue without a queue never throws (redis-unavailable)', async () => {
    const result = await service.enqueueDocument('doc-x', Buffer.from('x'), 'text/plain');
    expect(result).toEqual({ enqueued: false, reason: 'redis-unavailable' });
  });

  it('routes vectors by embedding width and rejects unknown widths', () => {
    expect(resolveEmbeddingColumn(1536)).toBe('embedding');
    expect(resolveEmbeddingColumn(2048)).toBe('embedding_halfvec');
    expect(resolveEmbeddingColumn(16)).toBe('embedding_v2');
    expect(() => resolveEmbeddingColumn(1024)).toThrow(/Unsupported embedding dimensions/);
  });
});
