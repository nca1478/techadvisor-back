import { AiConfigError, AiProviderError, AiRateLimitError } from '../ai-provider.error.js';
import { splitIntoBatches } from '../common/chunk-array.js';
import { parseRetryAfterMs, withRetry } from '../common/retry.js';
import type {
  EmbeddingProvider,
  EmbedOptions,
} from '../interfaces/embedding-provider.interface.js';

/**
 * Native adapter for NVIDIA NIM embedding endpoints (e.g.
 * `nvidia/nemotron-3-embed-1b` on https://integrate.api.nvidia.com/v1).
 *
 * A generic OpenAI-compatible adapter is NOT enough for this provider
 * (see ADR 0018), so this file exists alongside it — still the only place
 * (with its sibling adapters) allowed to run provider HTTP. Differences
 * from `openai-compatible`, and only these:
 *
 * - the `dimensions` parameter is NEVER sent (the model accepts it omitted
 *   or 2048; anything else is a 400);
 * - `input_type` is always sent from `EmbedOptions.kind`
 *   (`query` → `query`, anything else → `passage`, the safe indexing
 *   default). NVIDIA warns of large accuracy drops when it is missing;
 * - `modality: 'text'` is sent (the model is text-only).
 *
 * Batching, retries with backoff, timeouts and normalized errors are shared
 * with the generic adapter via `common/` — no duplicated policy.
 */

export interface NvidiaEmbeddingConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Must equal the model's native output (2048 for nemotron-3-embed-1b). */
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type NvidiaEmbeddingFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface EmbeddingsResponseData {
  embedding: unknown;
  index: unknown;
}

function isEmbeddingsPayload(value: unknown): value is { data: EmbeddingsResponseData[] } {
  if (value === null || typeof value !== 'object' || !('data' in value)) {
    return false;
  }
  return Array.isArray(value.data);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export class NvidiaEmbeddingAdapter implements EmbeddingProvider {
  readonly providerName = 'nvidia';
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: NvidiaEmbeddingFetch;

  constructor(config: NvidiaEmbeddingConfig, fetchImpl?: NvidiaEmbeddingFetch) {
    if (config.baseUrl.trim() === '') {
      throw new AiConfigError('EMBEDDING_BASE_URL is required', 'nvidia');
    }
    try {
      const parsed = new URL(config.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiConfigError('EMBEDDING_BASE_URL must be an http(s) URL', 'nvidia');
      }
    } catch (error) {
      if (error instanceof AiConfigError) {
        throw error;
      }
      throw new AiConfigError('EMBEDDING_BASE_URL must be a valid URL', 'nvidia');
    }
    if (config.model.trim() === '') {
      throw new AiConfigError('EMBEDDING_MODEL is required', 'nvidia');
    }
    if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
      throw new AiConfigError('EMBEDDING_DIM must be a positive integer', 'nvidia');
    }
    if (!Number.isInteger(config.batchSize) || config.batchSize <= 0) {
      throw new AiConfigError('EMBEDDING_BATCH_SIZE must be a positive integer', 'nvidia');
    }
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.batchSize = config.batchSize;
    this.timeoutMs = config.timeoutMs;
    this.maxAttempts = config.maxAttempts;
    this.baseDelayMs = config.baseDelayMs;
    this.maxDelayMs = config.maxDelayMs;
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const inputType = opts?.kind === 'query' ? 'query' : 'passage';
    const batches = splitIntoBatches(texts, this.batchSize);
    const out: number[][] = [];
    for (const batch of batches) {
      const { value } = await withRetry(
        () => this.embedBatch(batch, inputType),
        (error) => {
          if (error instanceof AiRateLimitError) {
            return { retryable: true, retryAfterMs: error.retryAfterMs };
          }
          if (error instanceof AiProviderError) {
            return { retryable: error.retryable };
          }
          return { retryable: true };
        },
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
        },
      );
      out.push(...value);
    }
    return out;
  }

  private async embedBatch(batch: string[], inputType: 'query' | 'passage'): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, '/embeddings'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey !== undefined && this.apiKey !== ''
            ? { authorization: `Bearer ${this.apiKey}` }
            : {}),
        },
        // No `dimensions`: nemotron-3-embed-1b only accepts it omitted
        // (native 2048). `modality` is text-only for this model.
        body: JSON.stringify({
          input: batch,
          model: this.model,
          input_type: inputType,
          modality: 'text',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiProviderError('timeout', 'Embedding request timed out', this.providerName, {
          cause: error,
        });
      }
      throw new AiProviderError('network', 'Embedding request failed', this.providerName, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AiProviderError(
        'auth',
        'Embedding provider rejected credentials',
        this.providerName,
        {
          status: response.status,
        },
      );
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new AiRateLimitError('Embedding provider rate limited', this.providerName, {
        status: 429,
        retryAfterMs,
      });
    }
    if (response.status === 400) {
      throw new AiProviderError(
        'bad_request',
        'Embedding provider rejected the request',
        this.providerName,
        {
          status: response.status,
        },
      );
    }
    if (response.status >= 500) {
      throw new AiProviderError(
        'server',
        'Embedding provider returned a server error',
        this.providerName,
        {
          status: response.status,
        },
      );
    }
    if (!response.ok) {
      throw new AiProviderError(
        'server',
        'Embedding provider returned an error',
        this.providerName,
        {
          status: response.status,
        },
      );
    }
    const payload: unknown = await response.json();
    return this.parseEmbeddings(payload, batch.length);
  }

  private parseEmbeddings(payload: unknown, expected: number): number[][] {
    if (!isEmbeddingsPayload(payload) || payload.data.length !== expected) {
      throw new AiProviderError(
        'server',
        'Embedding provider returned a malformed response',
        this.providerName,
      );
    }
    const ordered = [...payload.data].sort((a, b) => Number(a.index) - Number(b.index));
    return ordered.map((item) => {
      if (!Array.isArray(item.embedding) || item.embedding.length !== this.dimensions) {
        // Never mix dimensions in one column (AGENTS.md §5.3): fail loudly
        // instead of persisting a vector of the wrong length.
        throw new AiProviderError(
          'bad_request',
          'Embedding provider returned a vector with unexpected dimensions',
          this.providerName,
        );
      }
      const vector = item.embedding.map((value) => Number(value));
      if (vector.some((value) => !Number.isFinite(value))) {
        throw new AiProviderError(
          'server',
          'Embedding provider returned a malformed response',
          this.providerName,
        );
      }
      return vector;
    });
  }
}
