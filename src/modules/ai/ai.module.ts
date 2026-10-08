import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { createEmbeddingProvider } from './ai-provider.factory.js';
import { EMBEDDING_PROVIDER } from './interfaces/embedding-provider.interface.js';

/**
 * Provider-agnostic AI module (ADR 0016). Exposes the configured
 * `EmbeddingProvider` under the `EMBEDDING_PROVIDER` token; feature modules
 * inject the interface and never import `adapters/` directly.
 */
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createEmbeddingProvider(config),
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class AiModule {}
