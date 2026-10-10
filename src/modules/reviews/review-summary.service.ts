import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiProviderError, AiRateLimitError } from '../ai/ai-provider.error.js';
import { generateJson, LlmJsonError } from '../ai/common/generate-json.js';
import type { LlmProvider } from '../ai/interfaces/llm-provider.interface.js';
import { LLM_PROVIDER } from '../ai/interfaces/llm-provider.interface.js';
import { resolveLocale } from '../catalog/catalog.service.js';
import type { ReviewSummaryDto } from './dto/reviews.dto.js';
import {
  buildReviewSummaryUserMessage,
  loadReviewSummarySystemPrompt,
  renderReviewSummarySystemPrompt,
} from './review-summary.prompt.js';
import { reviewSummaryJsonSchema } from './review-summary.schemas.js';

/**
 * Pros/cons summaries over PUBLISHED reviews (see ADR 0037).
 *
 * `refreshProduct` is the single regeneration entry point ("the job"):
 * moderation hooks call it inline after every change touching PUBLISHED, so
 * the cached `product_review_summaries` row always reflects the current
 * published set (a BullMQ job can call the same method later without
 * changing the contract). Below `REVIEW_SUMMARY_MIN_REVIEWS` the row is
 * deleted (acceptance: no summary with fewer than N reviews).
 *
 * Trust model: reviews are UNTRUSTED data — delimited blocks, short
 * paraphrases only, no author identity in the prompt, no long quotes in the
 * output. `basedOnCount` is set server-side (never trusted from the model)
 * and the Zod schema (short strings, max 8 entries) survives prompt
 * injection: a model echoing injected instructions fails validation, uses
 * the single correction retry, and on persistent failure keeps the previous
 * summary (or no summary) instead of corrupt output.
 */
@Injectable()
export class ReviewSummaryService {
  private readonly logger = new Logger(ReviewSummaryService.name);
  private readonly systemTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // Fail fast at boot when the versioned prompt is missing.
    this.systemTemplate = loadReviewSummarySystemPrompt();
  }

  /**
   * Regenerates (or removes) the cached summary for one product from its
   * current PUBLISHED reviews. Never throws for LLM failures — a stale or
   * absent summary is always preferable to a 500 on a moderation write.
   * Returns the fresh row, or null when below the minimum or ungenerable.
   */
  async refreshProduct(productId: string): Promise<ReviewSummaryDto | null> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true },
    });
    if (product === null) {
      await this.prisma.productReviewSummary.deleteMany({ where: { productId } });
      return null;
    }
    const reviews = await this.prisma.review.findMany({
      where: { productId, status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.config.REVIEW_INGESTION_MAX_REVIEWS,
      select: { rating: true, title: true, body: true },
    });
    if (reviews.length < this.config.REVIEW_SUMMARY_MIN_REVIEWS) {
      await this.prisma.productReviewSummary.deleteMany({ where: { productId } });
      this.logger.debug(
        `review summary: skipped product=${productId} published=${String(reviews.length)} min=${String(this.config.REVIEW_SUMMARY_MIN_REVIEWS)}`,
      );
      return null;
    }
    const locale = resolveLocale(
      undefined,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );
    const system = renderReviewSummarySystemPrompt(this.systemTemplate, locale);
    const userMessage = buildReviewSummaryUserMessage({ productName: product.name, reviews });
    let data;
    try {
      ({ data } = await generateJson(this.llm, reviewSummaryJsonSchema, {
        system,
        messages: [{ role: 'user', content: userMessage }],
      }));
    } catch (error) {
      if (error instanceof LlmJsonError) {
        // Schema violation after the correction retry (e.g. a model echoing
        // injected review instructions): keep the previous summary instead
        // of persisting corrupt output. Metadata only in logs.
        this.logger.warn(
          `review summary: invalid model output kept previous product=${productId} issues=${String(error.issues.length)}`,
        );
        return this.findSummary(productId);
      }
      if (error instanceof AiRateLimitError) {
        this.logger.warn(`review summary: provider rate limited provider=${error.provider}`);
        throw new HttpException(
          { message: 'Review summary provider rate limited, try again later' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof AiProviderError) {
        this.logger.warn(
          `review summary: provider failed code=${error.code} provider=${error.provider}`,
        );
        return this.findSummary(productId);
      }
      throw error;
    }
    const row = await this.prisma.productReviewSummary.upsert({
      where: { productId },
      create: {
        productId,
        pros: data.pros,
        cons: data.cons,
        basedOnCount: reviews.length,
        model: this.llm.model,
      },
      update: {
        pros: data.pros,
        cons: data.cons,
        basedOnCount: reviews.length,
        model: this.llm.model,
      },
    });
    this.logger.debug(
      `review summary: refreshed product=${productId} basedOn=${String(reviews.length)} provider=${this.llm.providerName}`,
    );
    return this.toDto(productId, row);
  }

  async findSummary(productId: string): Promise<ReviewSummaryDto | null> {
    const row = await this.prisma.productReviewSummary.findUnique({ where: { productId } });
    if (row === null) {
      return null;
    }
    return this.toDto(productId, row);
  }

  private toDto(
    productId: string,
    row: {
      pros: unknown;
      cons: unknown;
      basedOnCount: number;
      model: string | null;
      updatedAt: Date;
    },
  ): ReviewSummaryDto {
    const pros = Array.isArray(row.pros)
      ? row.pros.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const cons = Array.isArray(row.cons)
      ? row.cons.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      productId,
      pros,
      cons,
      basedOnCount: row.basedOnCount,
      ...(row.model === null ? {} : { model: row.model }),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
