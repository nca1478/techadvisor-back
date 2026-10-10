import { AiProviderError } from '../ai/ai-provider.error.js';
import type {
  EmbedOptions,
  EmbeddingProvider,
} from '../ai/interfaces/embedding-provider.interface.js';
import type { AiCallLoggerService } from './ai-call-logger.service.js';

/**
 * Embedding provider decorator (see ADR 0039): delegates to the configured
 * adapter and logs one metadata-only row per `embed()` call without blocking
 * the response. Token counts are unknown for embeddings (no usage reported),
 * so cost stays NULL unless a caller supplies counts later.
 *
 * The wrapper only reads `providerName`/`model`/`dimensions` from the inner
 * provider — prompts and vectors never reach the logger (the `log()`
 * signature cannot carry them).
 */
export class LoggingEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly providerName: string;

  constructor(
    private readonly inner: EmbeddingProvider & { providerName?: string },
    private readonly logger: AiCallLoggerService,
  ) {
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.providerName =
      typeof inner.providerName === 'string' && inner.providerName.length > 0
        ? inner.providerName
        : 'unknown';
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    const startedAt = Date.now();
    try {
      const vectors = await this.inner.embed(texts, opts);
      this.logger.log({
        type: 'EMBEDDING',
        provider: this.providerName,
        model: this.model,
        latencyMs: Date.now() - startedAt,
        status: 'OK',
      });
      return vectors;
    } catch (error) {
      this.logger.log({
        type: 'EMBEDDING',
        provider: this.providerName,
        model: this.model,
        latencyMs: Date.now() - startedAt,
        status: 'ERROR',
        errorCode: normalizeErrorCode(error),
      });
      throw error;
    }
  }
}

/** Normalized error code without messages (messages may echo content). */
export function normalizeErrorCode(error: unknown): string {
  if (error instanceof AiProviderError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name.slice(0, 120) || 'Error';
  }
  return 'unknown';
}
