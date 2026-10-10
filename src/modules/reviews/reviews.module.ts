import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { AiModule } from '../ai/ai.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { AdminReviewsController } from './admin-reviews.controller.js';
import { ReviewIngestionService } from './review-ingestion.service.js';
import { ReviewSummaryService } from './review-summary.service.js';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

/**
 * Customer reviews + pros/cons summaries (Fase 6, P6.2 — see ADR 0037).
 *
 * Public `ReviewsController` (`/reviews`: create for verified buyers,
 * published list + cached summary per product) and `AdminReviewsController`
 * (`/admin/reviews`: list with filters, publish/reject). Publishing or
 * rejecting re-syncs the REVIEW corpus document (`ReviewIngestionService`,
 * backed by `IngestionModule`) and refreshes the cached summary
 * (`ReviewSummaryService`, backed by the configured `LlmProvider`) inline.
 */
@Module({
  imports: [AuthSecurityModule, AiModule, IngestionModule],
  controllers: [ReviewsController, AdminReviewsController],
  providers: [ReviewsService, ReviewIngestionService, ReviewSummaryService],
  exports: [ReviewsService, ReviewIngestionService, ReviewSummaryService],
})
export class ReviewsModule {}
