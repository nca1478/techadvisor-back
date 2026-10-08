import { AiConfigError, AiProviderError, AiRateLimitError } from '../ai-provider.error.js';
import { splitIntoBatches } from '../common/chunk-array.js';
import { parseRetryAfterMs, withRetry } from '../common/retry.js';
import type { EmbeddingProvider } from '../interfaces/embedding-provider.interface.js';

/**
 * Generic embedding adapter for any HTTP API exposing the OpenAI
 * `/embeddings` JSON format (OpenAI itself, OpenRouter, vLLM, Ollama, …).
 *
 * THIS FILE (plus the fake adapter) is the only place allowed to run
 * provider HTTP: the rest of the codebase talks to `EmbeddingProvider`.
 * `fetchImpl` defaults to the global `fetch` and is injectable so tests run
 * fully offline with a stub.
 *
 * Reduction of dimensions: when `dimensions` is set, it is forwarded as the
 * request `dimensions` field (supported by OpenAI `text-embedding-3-*` and
 * several compatible servers); servers that ignore unknown fields keep
 * working, and the response length is always validated below.
 */

export interface OpenAiCompatibleEmbeddingConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type EmbeddingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

export class OpenAiCompatibleEmbeddingAdapter implements EmbeddingProvider {
  readonly providerName = 'openai-compatible';
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: EmbeddingFetch;

  constructor(config: OpenAiCompatibleEmbeddingConfig, fetchImpl?: EmbeddingFetch) {
    if (config.baseUrl.trim() === '') {
      throw new AiConfigError('EMBEDDING_BASE_URL is required', 'openai-compatible');
    }
    try {
      const parsed = new URL(config.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiConfigError('EMBEDDING_BASE_URL must be an http(s) URL', 'openai-compatible');
      }
    } catch (error) {
      if (error instanceof AiConfigError) {
        throw error;
      }
      throw new AiConfigError('EMBEDDING_BASE_URL must be a valid URL', 'openai-compatible');
    }
    if (config.model.trim() === '') {
      throw new AiConfigError('EMBEDDING_MODEL is required', 'openai-compatible');
    }
    if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
      throw new AiConfigError('EMBEDDING_DIM must be a positive integer', 'openai-compatible');
    }
    if (!Number.isInteger(config.batchSize) || config.batchSize <= 0) {
      throw new AiConfigError(
        'EMBEDDING_BATCH_SIZE must be a positive integer',
        'openai-compatible',
      );
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

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const batches = splitIntoBatches(texts, this.batchSize);
    const out: number[][] = [];
    for (const batch of batches) {
      const { value } = await withRetry(
        () => this.embedBatch(batch),
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

  private async embedBatch(batch: string[]): Promise<number[][]> {
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
        body: JSON.stringify({ input: batch, model: this.model, dimensions: this.dimensions }),
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
          status: 400,
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
