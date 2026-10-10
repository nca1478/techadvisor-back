import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { IngestionService } from '../ingestion/ingestion.service.js';
import { buildReviewsText, ReviewIngestionService } from './review-ingestion.service.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const CONFIG = {
  DEFAULT_LOCALE: 'en',
  REVIEW_INGESTION_MAX_REVIEWS: 20,
} as unknown as AppConfig;

function buildService(options: {
  product?: { id: string; name: string; status: string; categoryId: string } | null;
  reviews?: Array<{ rating: number; title: string; body: string }>;
  existingDoc?: { id: string } | null;
  enqueueFails?: boolean;
}) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findFirstDoc = vi
    .fn()
    .mockResolvedValue(options.existingDoc === undefined ? null : options.existingDoc);
  const updateDoc = vi.fn().mockResolvedValue({ id: 'doc-1' });
  const createDoc = vi.fn().mockResolvedValue({ id: 'doc-1' });
  const prisma = {
    product: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.product === undefined
            ? { id: PRODUCT_ID, name: 'Ultrabook 14', status: 'ACTIVE', categoryId: 'cat-1' }
            : options.product,
        ),
    },
    review: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.reviews ?? [{ rating: 5, title: 'Great', body: 'Fast and light.' }],
        ),
    },
    document: {
      deleteMany,
      findFirst: findFirstDoc,
      update: updateDoc,
      create: createDoc,
    },
  } as unknown as PrismaService;
  const enqueueDocument =
    options.enqueueFails === true
      ? vi.fn().mockRejectedValue(new Error('redis down'))
      : vi.fn().mockResolvedValue({ enqueued: true });
  const ingestion = {
    enqueueDocument,
  } as unknown as IngestionService;
  const service = new ReviewIngestionService(prisma, ingestion, CONFIG);
  return { service, prisma, ingestion, deleteMany, createDoc, enqueueDocument };
}

describe('ReviewIngestionService', () => {
  it('upserts a REVIEW document and enqueues it (no author PII)', async () => {
    const { service, createDoc, enqueueDocument } = buildService({
      reviews: [{ rating: 5, title: 'Great', body: 'Fast and light.' }],
    });

    await service.syncProduct(PRODUCT_ID);

    expect(createDoc).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'REVIEW', source: 'auto:reviews', locale: 'en' }),
      select: { id: true },
    });
    expect(enqueueDocument).toHaveBeenCalledOnce();
    const [, payload] = enqueueDocument.mock.calls[0] as unknown as [string, Buffer, string];
    const text = payload.toString('utf8');
    expect(text).toContain('Fast and light.');
    expect(text).not.toContain('@');
    expect(text.toLowerCase()).not.toContain('user');
  });

  it('removes the REVIEW document when no published reviews remain', async () => {
    const { service, deleteMany, enqueueDocument } = buildService({ reviews: [] });

    await service.syncProduct(PRODUCT_ID);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID, source: 'auto:reviews' },
    });
    expect(enqueueDocument).not.toHaveBeenCalled();
  });

  it('removes the REVIEW document for non-ACTIVE products', async () => {
    const { service, deleteMany } = buildService({
      product: { id: PRODUCT_ID, name: 'Old', status: 'ARCHIVED', categoryId: 'cat-1' },
    });

    await service.syncProduct(PRODUCT_ID);

    expect(deleteMany).toHaveBeenCalled();
  });

  it('never throws when the queue is down', async () => {
    const { service } = buildService({ enqueueFails: true });

    await expect(service.syncProduct(PRODUCT_ID)).resolves.toBeUndefined();
  });
});

describe('buildReviewsText', () => {
  it('renders rating headlines without author data', () => {
    const text = buildReviewsText('Ultrabook 14', [
      { rating: 5, title: 'Great', body: 'Fast.' },
      { rating: 2, title: 'Meh', body: 'Heavy.' },
    ]);

    expect(text).toContain('# Customer reviews: Ultrabook 14');
    expect(text).toContain('## Great (5/5)');
    expect(text).toContain('## Meh (2/5)');
  });
});
