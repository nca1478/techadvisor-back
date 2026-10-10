import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';

/** `documents.source` marker for the review-generated REVIEW document. */
export const AUTO_REVIEWS_SOURCE = 'auto:reviews';

export const REVIEW_DOCUMENT_MARKDOWN_TYPE = 'text/markdown';

/** Max review body chars embedded per review (bounds the queue payload). */
export const MAX_REVIEW_CHARS_FOR_INGESTION = 800;

/**
 * Review corpus sync (see ADR 0037): one REVIEW document per product built
 * from its PUBLISHED reviews, reusing the standard pipeline
 * (`IngestionService.ingestDocument` via the BullMQ queue).
 *
 * `syncProduct` upserts the single `source = 'auto:reviews'` document and
 * enqueues it; with zero published reviews (or a non-ACTIVE/missing
 * product) the auto document is deleted so stale opinions never pollute
 * retrieval. It never throws — moderation writes must not break when the
 * queue is down — and only rating + title + body travel (no user ids,
 * emails or names: no author PII in the corpus by construction).
 */
@Injectable()
export class ReviewIngestionService {
  private readonly logger = new Logger(ReviewIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async syncProduct(productId: string): Promise<void> {
    try {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, status: true, categoryId: true },
      });
      if (product === null || product.status !== 'ACTIVE') {
        await this.prisma.document.deleteMany({
          where: { productId, source: AUTO_REVIEWS_SOURCE },
        });
        return;
      }
      const reviews = await this.prisma.review.findMany({
        where: { productId, status: 'PUBLISHED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: this.config.REVIEW_INGESTION_MAX_REVIEWS,
        select: { rating: true, title: true, body: true },
      });
      if (reviews.length === 0) {
        await this.prisma.document.deleteMany({
          where: { productId, source: AUTO_REVIEWS_SOURCE },
        });
        return;
      }
      const text = buildReviewsText(product.name, reviews);
      const title = `Customer reviews: ${product.name}`;
      const locale = this.config.DEFAULT_LOCALE;

      let documentId: string;
      const existing = await this.prisma.document.findFirst({
        where: { productId, source: AUTO_REVIEWS_SOURCE },
        select: { id: true },
      });
      if (existing) {
        const updated = await this.prisma.document.update({
          where: { id: existing.id },
          data: {
            type: 'REVIEW',
            title,
            locale,
            categoryId: product.categoryId,
            status: 'PENDING',
            error: null,
          },
          select: { id: true },
        });
        documentId = updated.id;
      } else {
        try {
          const created = await this.prisma.document.create({
            data: {
              productId,
              categoryId: product.categoryId,
              type: 'REVIEW',
              title,
              locale,
              source: AUTO_REVIEWS_SOURCE,
              contentHash: 'pending',
              status: 'PENDING',
            },
            select: { id: true },
          });
          documentId = created.id;
        } catch {
          // Lost a create race (unique productId+source): re-read the winner.
          const winner = await this.prisma.document.findFirst({
            where: { productId, source: AUTO_REVIEWS_SOURCE },
            select: { id: true },
          });
          if (!winner) {
            throw new Error('auto REVIEW document vanished after unique conflict');
          }
          documentId = winner.id;
        }
      }
      await this.ingestion.enqueueDocument(
        documentId,
        Buffer.from(text, 'utf8'),
        REVIEW_DOCUMENT_MARKDOWN_TYPE,
      );
    } catch (error) {
      this.logger.warn(
        `Skipping REVIEW sync for product ${productId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

/**
 * Renders published reviews as readable markdown. Newest first (input
 * order), truncated per review so the payload stays bounded. No author
 * data is rendered — only rating + title + body.
 */
export function buildReviewsText(
  productName: string,
  reviews: Array<{ rating: number; title: string; body: string }>,
): string {
  const lines = [`# Customer reviews: ${productName}`, ''];
  for (const review of reviews) {
    const body =
      review.body.length > MAX_REVIEW_CHARS_FOR_INGESTION
        ? `${review.body.slice(0, MAX_REVIEW_CHARS_FOR_INGESTION)}…`
        : review.body;
    lines.push(`## ${review.title} (${String(review.rating)}/5)`, '', body, '');
  }
  return `${lines.join('\n').trim()}\n`;
}
