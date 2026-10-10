import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  AdminReviewDto,
  AdminReviewListDto,
  ReviewDto,
  ReviewListDto,
  ReviewSummaryDto,
} from './dto/reviews.dto.js';
import { ReviewIngestionService } from './review-ingestion.service.js';
import { ReviewSummaryService } from './review-summary.service.js';
import type {
  AdminReviewListQuery,
  CreateReviewInput,
  ReviewListQuery,
} from './reviews.schemas.js';

/** Order states proving a purchase (task contract: only these may review). */
const PURCHASE_ORDER_STATUSES = ['PAID', 'DELIVERED'] as const;

type ReviewRow = {
  id: string;
  productId: string;
  userId: string;
  rating: number;
  title: string;
  body: string;
  verifiedPurchase: boolean;
  status: string;
  createdAt: Date;
};

/**
 * Customer reviews (see ADR 0037).
 *
 * - Creation requires an ACTIVE product, no existing review by the same
 *   user for it (409), and a PAID/DELIVERED order of that user containing
 *   the product (else 403). Unknown or non-ACTIVE products 404 exactly
 *   like unknown ids so the endpoint never reveals non-active products.
 * - Public reads return PUBLISHED rows only (no author ids, no status).
 * - Moderation flips PENDING/PUBLISHED/REJECTED; every change touching
 *   PUBLISHED re-syncs the REVIEW corpus document and refreshes the cached
 *   pros/cons summary inline (best-effort, never throwing).
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewIngestion: ReviewIngestionService,
    private readonly summaries: ReviewSummaryService,
  ) {}

  async createReview(userId: string, input: CreateReviewInput): Promise<ReviewDto> {
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (product === null) {
      throw new NotFoundException({ message: 'Product not found' });
    }
    const existing = await this.prisma.review.findUnique({
      where: { productId_userId: { productId: input.productId, userId } },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException({ message: 'You have already reviewed this product' });
    }
    const purchase = await this.prisma.order.findFirst({
      where: {
        userId,
        status: { in: [...PURCHASE_ORDER_STATUSES] },
        items: { some: { productId: input.productId } },
      },
      select: { id: true },
    });
    if (purchase === null) {
      throw new ForbiddenException({
        message: 'Only customers who bought this product can review it',
      });
    }
    const row = await this.prisma.review.create({
      data: {
        productId: input.productId,
        userId,
        rating: input.rating,
        title: input.title,
        body: input.body,
        verifiedPurchase: true,
        status: 'PENDING',
      },
    });
    // PENDING reviews change neither the corpus nor the summary: nothing to sync.
    this.logger.debug(`review created product=${input.productId} status=PENDING`);
    return toPublicDto(row);
  }

  async listPublished(productId: string, query: ReviewListQuery): Promise<ReviewListDto> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (product === null) {
      throw new NotFoundException({ message: 'Product not found' });
    }
    const where = { productId, status: 'PUBLISHED' as const };
    const skip = (query.page - 1) * query.limit;
    const [total, rows, aggregate] = await this.prisma.$transaction([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
      this.prisma.review.aggregate({ where, _avg: { rating: true } }),
    ]);
    return {
      data: rows.map(toPublicDto),
      total,
      page: query.page,
      limit: query.limit,
      averageRating: aggregate._avg.rating,
    };
  }

  async getSummary(productId: string): Promise<ReviewSummaryDto | null> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (product === null) {
      throw new NotFoundException({ message: 'Product not found' });
    }
    return this.summaries.findSummary(productId);
  }

  async listForAdmin(query: AdminReviewListQuery): Promise<AdminReviewListDto> {
    const where: { status?: 'PENDING' | 'PUBLISHED' | 'REJECTED'; productId?: string } = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.productId !== undefined) {
      where.productId = query.productId;
    }
    const skip = (query.page - 1) * query.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);
    return {
      data: rows.map(toAdminDto),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Moderates one review. Allowed: PENDING → PUBLISHED | REJECTED,
   * PUBLISHED → REJECTED, REJECTED → PUBLISHED (re-publish). Re-setting the
   * current status is a no-op returning the row. Changes touching PUBLISHED
   * re-sync the REVIEW document and refresh the summary inline.
   */
  async moderateReview(id: string, status: 'PUBLISHED' | 'REJECTED'): Promise<AdminReviewDto> {
    const row = await this.prisma.review.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException({ message: 'Review not found' });
    }
    if (row.status === status) {
      return toAdminDto(row);
    }
    const updated = await this.prisma.review.update({ where: { id }, data: { status } });
    if (row.status === 'PUBLISHED' || status === 'PUBLISHED') {
      await this.afterPublishedChange(updated.productId);
    }
    this.logger.debug(`review moderated id=${id} ${row.status}->${status}`);
    return toAdminDto(updated);
  }

  /**
   * Corpus + summary refresh after any PUBLISHED-set change. Best-effort:
   * both callees swallow their own failures, and this wrapper guards the
   * remainder so moderation writes never 500 because of a side effect.
   */
  private async afterPublishedChange(productId: string): Promise<void> {
    try {
      await this.reviewIngestion.syncProduct(productId);
    } catch (error) {
      this.logger.warn(
        `review side effects: ingestion sync failed product=${productId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    try {
      await this.summaries.refreshProduct(productId);
    } catch (error) {
      this.logger.warn(
        `review side effects: summary refresh failed product=${productId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}

function toPublicDto(row: ReviewRow): ReviewDto {
  return {
    id: row.id,
    productId: row.productId,
    rating: row.rating,
    title: row.title,
    body: row.body,
    verifiedPurchase: row.verifiedPurchase,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAdminDto(row: ReviewRow): AdminReviewDto {
  return {
    id: row.id,
    productId: row.productId,
    rating: row.rating,
    title: row.title,
    body: row.body,
    verifiedPurchase: row.verifiedPurchase,
    createdAt: row.createdAt.toISOString(),
    status: row.status as AdminReviewDto['status'],
    userId: row.userId,
  };
}
