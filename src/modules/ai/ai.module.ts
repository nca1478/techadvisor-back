import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AiCallLoggerService } from '../observability/ai-call-logger.service.js';
import { AiCallLoggerModule } from '../observability/ai-call-logger.module.js';
import { LoggingEmbeddingProvider } from '../observability/instrumented-embedding.provider.js';
import { LoggingLlmProvider } from '../observability/instrumented-llm.provider.js';
import { createEmbeddingProvider, createLlmProvider } from './ai-provider.factory.js';
import { EMBEDDING_PROVIDER } from './interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from './interfaces/llm-provider.interface.js';

/**
 * Provider-agnostic AI module (ADRs 0016, 0024, 0039). Exposes the configured
 * `EmbeddingProvider` and `LlmProvider` under their tokens wrapped with the
 * metadata-only logging decorators; feature modules inject the interfaces
 * and never import `adapters/` directly.
 */
@Module({
  imports: [AiCallLoggerModule],
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [APP_CONFIG, AiCallLoggerService],
      useFactory: (config: AppConfig, logger: AiCallLoggerService) =>
        new LoggingEmbeddingProvider(createEmbeddingProvider(config), logger),
    },
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG, AiCallLoggerService],
      useFactory: (config: AppConfig, logger: AiCallLoggerService) =>
        new LoggingLlmProvider(createLlmProvider(config), logger),
    },
  ],
  exports: [EMBEDDING_PROVIDER, LLM_PROVIDER],
})
export class AiModule {}
