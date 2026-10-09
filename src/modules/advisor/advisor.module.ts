import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { OptionalJwtAuthGuard } from '../cart/optional-jwt-auth.guard.js';
import { AdvisorController } from './advisor.controller.js';
import { AdvisorService } from './advisor.service.js';
import { ChatSessionsController } from './chat-sessions.controller.js';
import { ChatSessionsService } from './chat-sessions.service.js';

/**
 * Product-QA advisor module (see ADR 0025) plus chat-session history
 * (see ADR 0029).
 *
 * Exposes `POST /advisor/product-qa` backed by `RetrievalService` (hybrid
 * retrieval) and the configured `LlmProvider` — no provider SDK is ever
 * imported here — plus the stub `POST /advisor/feedback` (append-only
 * votes, no LLM involved). `ChatSessionsController` persists conversation
 * history under `advisor/sessions` for authenticated users and anonymous
 * guests (signed `sid` cookie, same scheme as carts); `AuthSecurityModule`
 * provides the JWT primitives and `OptionalJwtAuthGuard` (shared source
 * with carts, registered here as its own provider instance) resolves the
 * owner. `InventoryService` and `APP_CONFIG` are global; price, availability
 * and specs always come from SQL, never from the LLM.
 */
@Module({
  imports: [RetrievalModule, AiModule, AuthSecurityModule],
  controllers: [AdvisorController, ChatSessionsController],
  providers: [AdvisorService, ChatSessionsService, OptionalJwtAuthGuard],
})
export class AdvisorModule {}
