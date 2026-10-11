import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ReviewIngestionService } from './review-ingestion.service.js';
import type { ReviewSummaryService } from './review-summary.service.js';
import { ReviewsService } from './reviews.service.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    productId: PRODUCT_ID,
    product: { name: 'Fixture Motherboard Z890' },
    userId: USER_ID,
    rating: 5,
    title: 'Great laptop',
    body: 'Fast and light.',
    verifiedPurchase: true,
    status: 'PENDING',
    createdAt: new Date('2026-02-01T10:00:00.000Z'),
    ...overrides,
  };
}

function buildService(options: {
  product?: { id: string } | null;
  existingReview?: { id: string } | null;
  purchase?: { id: string } | null;
  created?: ReturnType<typeof reviewRow>;
  moderateRow?: ReturnType<typeof reviewRow>;
}) {
  const findFirstProduct = vi
    .fn()
    .mockResolvedValue(options.product === undefined ? { id: PRODUCT_ID } : options.product);
  const findUniqueReview = vi
    .fn()
    .mockResolvedValue(options.existingReview === undefined ? null : options.existingReview);
  const findFirstOrder = vi
    .fn()
    .mockResolvedValue(options.purchase === undefined ? null : options.purchase);
  const createReview = vi.fn().mockResolvedValue(options.created ?? reviewRow());
  const findUniqueById = vi.fn().mockResolvedValue(options.moderateRow ?? null);
  const updateReview = vi
    .fn()
    .mockImplementation(({ data }: { data: { status: string } }) =>
      Promise.resolve(reviewRow({ ...(options.moderateRow ?? {}), status: data.status })),
    );
  const prisma = {
    product: { findFirst: findFirstProduct },
    review: {
      findUnique: findUniqueReview,
      findFirst: findFirstOrder,
      create: createReview,
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _avg: { rating: null } }),
    },
    order: { findFirst: findFirstOrder },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  // findUnique is shared between the duplicate check and moderation reads;
  // moderation tests override via `moderateRow`, creation tests via
  // `existingReview` — disambiguate by call shape below.
  findUniqueReview.mockImplementation((args: unknown) => {
    const where = (args as { where: Record<string, unknown> }).where;
    if (where['id'] !== undefined) {
      return Promise.resolve(options.moderateRow ?? null);
    }
    return Promise.resolve(options.existingReview === undefined ? null : options.existingReview);
  });
  const ingestion = {
    syncProduct: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReviewIngestionService;
  const summaries = {
    refreshProduct: vi.fn().mockResolvedValue(null),
    findSummary: vi.fn().mockResolvedValue(null),
  } as unknown as ReviewSummaryService;
  const service = new ReviewsService(prisma, ingestion, summaries);
  return {
    service,
    prisma,
    ingestion,
    summaries,
    findFirstProduct,
    findUniqueReview,
    findFirstOrder,
    createReview,
    findUniqueById,
    updateReview,
  };
}

describe('ReviewsService.createReview (authorization)', () => {
  it('creates a PENDING verified review for a buyer with a PAID order', async () => {
    const created = reviewRow({ status: 'PENDING', verifiedPurchase: true });
    const { service, createReview, findFirstOrder } = buildService({
      purchase: { id: 'order-1' },
      created,
    });

    const result = await service.createReview(USER_ID, {
      productId: PRODUCT_ID,
      rating: 5,
      title: 'Great laptop',
      body: 'Fast and light.',
    });

    expect(result).toMatchObject({ productId: PRODUCT_ID, rating: 5, verifiedPurchase: true });
    expect(findFirstOrder).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        status: { in: ['PAID', 'DELIVERED'] },
        items: { some: { productId: PRODUCT_ID } },
      },
      select: { id: true },
    });
    expect(createReview).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'PENDING', verifiedPurchase: true }),
    });
  });

  it('404s for unknown or non-ACTIVE products (never revealing them)', async () => {
    const { service } = buildService({ product: null });

    await expect(
      service.createReview(USER_ID, {
        productId: PRODUCT_ID,
        rating: 4,
        title: 'Ok',
        body: 'Fine.',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403s when the user never bought the product (no PAID/DELIVERED order)', async () => {
    const { service } = buildService({ purchase: null });

    await expect(
      service.createReview(USER_ID, {
        productId: PRODUCT_ID,
        rating: 4,
        title: 'Ok',
        body: 'Fine.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('409s on a second review of the same product by the same user', async () => {
    const { service } = buildService({
      purchase: { id: 'order-1' },
      existingReview: { id: 'old-review' },
    });

    await expect(
      service.createReview(USER_ID, {
        productId: PRODUCT_ID,
        rating: 3,
        title: 'Again',
        body: 'Second try.',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ReviewsService.moderateReview (moderation)', () => {
  function moderationService(current: string) {
    const syncProduct = vi.fn().mockResolvedValue(undefined);
    const refreshProduct = vi.fn().mockResolvedValue(null);
    const row = reviewRow({ status: current });
    const updated = { ...row, status: 'PUBLISHED' };
    const prisma = {
      review: {
        findUnique: vi.fn().mockResolvedValue(row),
        update: vi.fn().mockResolvedValue(updated),
      },
    } as unknown as PrismaService;
    const ingestion = { syncProduct } as unknown as ReviewIngestionService;
    const summaries = {
      refreshProduct,
      findSummary: vi.fn(),
    } as unknown as ReviewSummaryService;
    return {
      service: new ReviewsService(prisma, ingestion, summaries),
      prisma,
      syncProduct,
      refreshProduct,
    };
  }

  it('publishes a PENDING review and refreshes corpus + summary', async () => {
    const { service, syncProduct, refreshProduct } = moderationService('PENDING');

    const result = await service.moderateReview('review-id', 'PUBLISHED');

    expect(result.status).toBe('PUBLISHED');
    expect(result.productName).toBe('Fixture Motherboard Z890');
    expect(syncProduct).toHaveBeenCalledWith(PRODUCT_ID);
    expect(refreshProduct).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('rejecting a PUBLISHED review also refreshes (it leaves the set)', async () => {
    const syncProduct = vi.fn().mockResolvedValue(undefined);
    const refreshProduct = vi.fn().mockResolvedValue(null);
    const row = reviewRow({ status: 'PUBLISHED' });
    const prisma = {
      review: {
        findUnique: vi.fn().mockResolvedValue(row),
        update: vi.fn().mockResolvedValue({ ...row, status: 'REJECTED' }),
      },
    } as unknown as PrismaService;
    const service = new ReviewsService(
      prisma,
      { syncProduct } as unknown as ReviewIngestionService,
      { refreshProduct, findSummary: vi.fn() } as unknown as ReviewSummaryService,
    );

    const result = await service.moderateReview('review-id', 'REJECTED');

    expect(result.status).toBe('REJECTED');
    expect(syncProduct).toHaveBeenCalledWith(PRODUCT_ID);
    expect(refreshProduct).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('re-setting the current status is a no-op without side effects', async () => {
    const syncProduct = vi.fn().mockResolvedValue(undefined);
    const refreshProduct = vi.fn().mockResolvedValue(null);
    const row = reviewRow({ status: 'PUBLISHED' });
    const update = vi.fn();
    const prisma = {
      review: { findUnique: vi.fn().mockResolvedValue(row), update },
    } as unknown as PrismaService;
    const service = new ReviewsService(
      prisma,
      { syncProduct } as unknown as ReviewIngestionService,
      { refreshProduct, findSummary: vi.fn() } as unknown as ReviewSummaryService,
    );

    const result = await service.moderateReview('review-id', 'PUBLISHED');

    expect(result.status).toBe('PUBLISHED');
    expect(update).not.toHaveBeenCalled();
    expect(syncProduct).not.toHaveBeenCalled();
    expect(refreshProduct).not.toHaveBeenCalled();
  });

  it('404s for unknown review ids', async () => {
    const prisma = {
      review: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    } as unknown as PrismaService;
    const service = new ReviewsService(
      prisma,
      { syncProduct: vi.fn() } as unknown as ReviewIngestionService,
      { refreshProduct: vi.fn(), findSummary: vi.fn() } as unknown as ReviewSummaryService,
    );

    await expect(service.moderateReview('missing', 'PUBLISHED')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ReviewsService.listForAdmin (moderation list)', () => {
  it('maps the joined product name into each row', async () => {
    const rows = [reviewRow({ status: 'PENDING' })];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      review: {
        count: vi.fn().mockResolvedValue(1),
        findMany,
      },
      $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    const service = new ReviewsService(
      prisma,
      { syncProduct: vi.fn() } as unknown as ReviewIngestionService,
      { refreshProduct: vi.fn(), findSummary: vi.fn() } as unknown as ReviewSummaryService,
    );

    const result = await service.listForAdmin({ page: 1, limit: 10 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { product: { select: { name: true } } } }),
    );
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      productId: PRODUCT_ID,
      productName: 'Fixture Motherboard Z890',
    });
  });
});

describe('ReviewsService.listPublished (public surface)', () => {
  it('returns published rows without author ids or statuses', async () => {
    const rows = [reviewRow({ status: 'PUBLISHED' }), reviewRow({ status: 'PUBLISHED' })];
    const prisma = {
      product: { findFirst: vi.fn().mockResolvedValue({ id: PRODUCT_ID }) },
      review: {
        count: vi.fn().mockResolvedValue(2),
        findMany: vi.fn().mockResolvedValue(rows),
        aggregate: vi.fn().mockResolvedValue({ _avg: { rating: 4.5 } }),
      },
      $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    const service = new ReviewsService(
      prisma,
      { syncProduct: vi.fn() } as unknown as ReviewIngestionService,
      { refreshProduct: vi.fn(), findSummary: vi.fn() } as unknown as ReviewSummaryService,
    );

    const result = await service.listPublished(PRODUCT_ID, { page: 1, limit: 10 });

    expect(result.total).toBe(2);
    expect(result.averageRating).toBe(4.5);
    for (const entry of result.data) {
      expect(entry).not.toHaveProperty('userId');
      expect(entry).not.toHaveProperty('status');
      expect(entry.verifiedPurchase).toBe(true);
    }
  });
});
