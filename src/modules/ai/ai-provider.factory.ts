import type { AppConfig } from '../../config/env.schema.js';
import type { EmbeddingProvider } from './interfaces/embedding-provider.interface.js';
import { FakeEmbeddingAdapter } from './adapters/fake-embedding.adapter.js';
import { NvidiaEmbeddingAdapter } from './adapters/nvidia-embedding.adapter.js';
import {
  OpenAiCompatibleEmbeddingAdapter,
  type EmbeddingFetch,
} from './adapters/openai-compatible-embedding.adapter.js';
import { AiConfigError } from './ai-provider.error.js';

/**
 * Chooses the embedding adapter from `EMBEDDING_PROVIDER` (see ADR 0016).
 * Adding a provider = a new adapter + one branch here; consumers keep
 * injecting the `EMBEDDING_PROVIDER` token unchanged.
 */
export function createEmbeddingProvider(
  config: AppConfig,
  fetchImpl?: EmbeddingFetch,
): EmbeddingProvider {
  switch (config.EMBEDDING_PROVIDER) {
    case 'fake':
      return new FakeEmbeddingAdapter({
        model: config.EMBEDDING_MODEL,
        dimensions: config.EMBEDDING_DIM,
      });
    case 'openai-compatible':
      return new OpenAiCompatibleEmbeddingAdapter(
        {
          baseUrl: config.EMBEDDING_BASE_URL ?? '',
          apiKey: config.EMBEDDING_API_KEY,
          // Empty model/baseUrl fall through to the adapter's AiConfigError;
          // the env schema already rejects this combination at boot.
          model: config.EMBEDDING_MODEL ?? '',
          dimensions: config.EMBEDDING_DIM,
          batchSize: config.EMBEDDING_BATCH_SIZE,
          timeoutMs: config.EMBEDDING_TIMEOUT_MS,
          maxAttempts: config.EMBEDDING_MAX_ATTEMPTS,
          baseDelayMs: config.EMBEDDING_RETRY_BASE_DELAY_MS,
          maxDelayMs: config.EMBEDDING_RETRY_MAX_DELAY_MS,
        },
        fetchImpl,
      );
    case 'nvidia':
      return new NvidiaEmbeddingAdapter(
        {
          baseUrl: config.EMBEDDING_BASE_URL ?? '',
          apiKey: config.EMBEDDING_API_KEY,
          // Empty model/baseUrl fall through to the adapter's AiConfigError;
          // the env schema already rejects this combination at boot.
          model: config.EMBEDDING_MODEL ?? '',
          dimensions: config.EMBEDDING_DIM,
          batchSize: config.EMBEDDING_BATCH_SIZE,
          timeoutMs: config.EMBEDDING_TIMEOUT_MS,
          maxAttempts: config.EMBEDDING_MAX_ATTEMPTS,
          baseDelayMs: config.EMBEDDING_RETRY_BASE_DELAY_MS,
          maxDelayMs: config.EMBEDDING_RETRY_MAX_DELAY_MS,
        },
        fetchImpl,
      );
    default:
      throw new AiConfigError(
        `Unknown EMBEDDING_PROVIDER "${String(config.EMBEDDING_PROVIDER)}"`,
        'factory',
      );
  }
}
