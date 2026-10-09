import type { AppConfig } from '../../config/env.schema.js';
import type { EmbeddingProvider } from './interfaces/embedding-provider.interface.js';
import type { LlmProvider } from './interfaces/llm-provider.interface.js';
import {
  AnthropicLlmAdapter,
  type AnthropicClientFactory,
} from './adapters/anthropic-llm.adapter.js';
import { FakeEmbeddingAdapter } from './adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from './adapters/fake-llm.adapter.js';
import { NvidiaEmbeddingAdapter } from './adapters/nvidia-embedding.adapter.js';
import {
  OpenAiCompatibleEmbeddingAdapter,
  type EmbeddingFetch,
} from './adapters/openai-compatible-embedding.adapter.js';
import {
  OpenAiCompatibleLlmAdapter,
  type LlmFetch,
} from './adapters/openai-compatible-llm.adapter.js';
import {
  OpenAiResponsesLlmAdapter,
  type ResponsesFetch,
} from './adapters/openai-responses-llm.adapter.js';
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

/**
 * Chooses the LLM adapter from `LLM_PROVIDER` (see ADR 0024).
 * Adding a provider = a new adapter + one branch here; consumers keep
 * injecting the `LLM_PROVIDER` token unchanged. `fetchImpl` (HTTP stub for
 * `openai-compatible` and `openai-responses`) and `anthropicClientFactory`
 * (SDK stub for `anthropic`) exist so tests prove config-only switching
 * with no network.
 */
export function createLlmProvider(
  config: AppConfig,
  fetchImpl?: LlmFetch | ResponsesFetch,
  anthropicClientFactory?: AnthropicClientFactory,
): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'fake':
      return new FakeLlmAdapter({ model: config.LLM_MODEL ?? 'fake-llm-v1' });
    case 'openai-compatible':
      return new OpenAiCompatibleLlmAdapter(
        {
          baseUrl: config.LLM_BASE_URL ?? '',
          apiKey: config.LLM_API_KEY,
          // Empty model/baseUrl fall through to the adapter's AiConfigError;
          // the env schema already rejects this combination at boot.
          model: config.LLM_MODEL ?? '',
          timeoutMs: config.LLM_TIMEOUT_MS,
          maxAttempts: config.LLM_MAX_ATTEMPTS,
          baseDelayMs: config.LLM_RETRY_BASE_DELAY_MS,
          maxDelayMs: config.LLM_RETRY_MAX_DELAY_MS,
          defaultMaxTokens: config.LLM_MAX_TOKENS,
        },
        fetchImpl,
      );
    case 'anthropic':
      return new AnthropicLlmAdapter(
        {
          apiKey: config.LLM_API_KEY,
          baseUrl: config.LLM_BASE_URL,
          // Empty model falls through to the adapter's AiConfigError; the
          // env schema already rejects it at boot.
          model: config.LLM_MODEL ?? '',
          timeoutMs: config.LLM_TIMEOUT_MS,
          maxAttempts: config.LLM_MAX_ATTEMPTS,
          baseDelayMs: config.LLM_RETRY_BASE_DELAY_MS,
          maxDelayMs: config.LLM_RETRY_MAX_DELAY_MS,
          defaultMaxTokens: config.LLM_MAX_TOKENS,
        },
        anthropicClientFactory,
      );
    case 'openai-responses':
      return new OpenAiResponsesLlmAdapter(
        {
          baseUrl: config.LLM_BASE_URL ?? '',
          apiKey: config.LLM_API_KEY,
          // Empty model/baseUrl fall through to the adapter's AiConfigError;
          // the env schema already rejects this combination at boot.
          model: config.LLM_MODEL ?? '',
          timeoutMs: config.LLM_TIMEOUT_MS,
          maxAttempts: config.LLM_MAX_ATTEMPTS,
          baseDelayMs: config.LLM_RETRY_BASE_DELAY_MS,
          maxDelayMs: config.LLM_RETRY_MAX_DELAY_MS,
          defaultMaxTokens: config.LLM_MAX_TOKENS,
          reasoningEffort: config.LLM_REASONING_EFFORT,
        },
        fetchImpl,
      );
    default:
      throw new AiConfigError(`Unknown LLM_PROVIDER "${String(config.LLM_PROVIDER)}"`, 'factory');
  }
}
