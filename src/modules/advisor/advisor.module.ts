import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { AdvisorController } from './advisor.controller.js';
import { AdvisorService } from './advisor.service.js';

/**
 * Product-QA advisor module (see ADR 0025).
 *
 * Exposes `POST /advisor/product-qa` backed by `RetrievalService` (hybrid
 * retrieval) and the configured `LlmProvider` — no provider SDK is ever
 * imported here. `InventoryService` and `APP_CONFIG` are global; price,
 * availability and specs always come from SQL, never from the LLM.
 */
@Module({
  imports: [RetrievalModule, AiModule],
  controllers: [AdvisorController],
  providers: [AdvisorService],
})
export class AdvisorModule {}
