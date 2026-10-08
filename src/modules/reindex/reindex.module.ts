import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { EmbeddingStateService } from './embedding-state.service.js';
import { REINDEX_QUEUE } from './reindex.constants.js';
import { ReindexController } from './reindex.controller.js';
import { createReindexQueue } from './reindex.queue.js';
import { ReindexService } from './reindex.service.js';

/**
 * Zero-downtime embedding model switching (see ADR 0023).
 *
 * Owns the persisted active-model pointer (`EmbeddingStateService`), the
 * batched reindex pipeline (`ReindexService` + the `reindex` BullMQ queue)
 * and its admin surface (`ReindexController`, behind `AuthSecurityModule`
 * JWT + ADMIN guards like every other back-office route). `RetrievalModule` imports
 * this module so hybrid search always queries the ACTIVE model and column —
 * live search never observes a half-reindexed corpus.
 */
@Module({
  imports: [AuthSecurityModule],
  controllers: [ReindexController],
  providers: [
    EmbeddingStateService,
    ReindexService,
    {
      provide: REINDEX_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createReindexQueue(config),
    },
  ],
  exports: [EmbeddingStateService, ReindexService, REINDEX_QUEUE],
})
export class ReindexModule {}
