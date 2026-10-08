import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { RetrievalService } from './retrieval.service.js';

/**
 * Hybrid RAG retrieval module (see ADR 0021).
 *
 * Exposes `RetrievalService` (vector + full-text + RRF) to the advisor and
 * search features. Depends on `AiModule` for the configured
 * `EmbeddingProvider` — no provider SDK is ever imported here.
 */
@Module({
  imports: [AiModule],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
