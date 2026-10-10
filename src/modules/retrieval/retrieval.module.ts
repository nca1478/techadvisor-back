import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AiCallLoggerModule } from '../observability/ai-call-logger.module.js';
import { ReindexModule } from '../reindex/reindex.module.js';
import { RetrievalService } from './retrieval.service.js';

/**
 * Hybrid RAG retrieval module (see ADR 0021).
 *
 * Exposes `RetrievalService` (vector + full-text + RRF) to the advisor and
 * search features. Depends on `AiModule` for the configured
 * `EmbeddingProvider` — no provider SDK is ever imported here — and on
 * `ReindexModule` for the persisted ACTIVE model, so live search always
 * queries the activated model/column and never a half-reindexed corpus
 * (see ADR 0023).
 */
@Module({
  imports: [AiModule, AiCallLoggerModule, ReindexModule],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
