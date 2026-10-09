import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { createEmbeddingProvider, createLlmProvider } from './ai-provider.factory.js';
import { EMBEDDING_PROVIDER } from './interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from './interfaces/llm-provider.interface.js';

/**
 * Provider-agnostic AI module (ADRs 0016, 0024). Exposes the configured
 * `EmbeddingProvider` and `LlmProvider` under their tokens; feature modules
 * inject the interfaces and never import `adapters/` directly.
 */
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createEmbeddingProvider(config),
    },
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createLlmProvider(config),
    },
  ],
  exports: [EMBEDDING_PROVIDER, LLM_PROVIDER],
})
export class AiModule {}
