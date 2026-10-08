import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../ai-provider.error.js';
import {
  OpenAiCompatibleEmbeddingAdapter,
  type EmbeddingFetch,
  type OpenAiCompatibleEmbeddingConfig,
} from './openai-compatible-embedding.adapter.js';

const DIM = 4;

const BASE_CONFIG: OpenAiCompatibleEmbeddingConfig = {
  baseUrl: 'https://embeddings.example.com/v1/',
  apiKey: 'test-key',
  model: 'test-model',
  dimensions: DIM,
  batchSize: 100,
  timeoutMs: 5000,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
};

interface SeenRequest {
  url: string;
  init: RequestInit | undefined;
  body: { input: string[]; model: string; dimensions: number };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function embeddingPayload(count: number, dim: number): unknown {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      object: 'embedding',
      embedding: Array.from({ length: dim }, (_, d) => i * dim + d + 0.5),
      index: i,
    })),
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function bodyOf(init: RequestInit | undefined): SeenRequest['body'] {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string body');
  }
  return JSON.parse(init.body) as SeenRequest['body'];
}

function recordSeen(seen: SeenRequest[]): EmbeddingFetch {
  return (input, init) => {
    const body = bodyOf(init);
    seen.push({ url: urlOf(input), init, body });
    return Promise.resolve(jsonResponse(200, embeddingPayload(body.input.length, DIM)));
  };
}

describe('OpenAiCompatibleEmbeddingAdapter', () => {
  it('posts model + dimensions to <baseUrl>/embeddings with bearer auth', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new OpenAiCompatibleEmbeddingAdapter(BASE_CONFIG, recordSeen(seen));

    const vectors = await adapter.embed(['hola']);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://embeddings.example.com/v1/embeddings');
    expect(seen[0]?.body).toEqual({ input: ['hola'], model: 'test-model', dimensions: DIM });
    expect(seen[0]?.init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(vectors).toEqual([[0.5, 1.5, 2.5, 3.5]]);
  });

  it('omits the auth header when no api key is configured', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new OpenAiCompatibleEmbeddingAdapter(
      { ...BASE_CONFIG, apiKey: undefined },
      recordSeen(seen),
    );

    await adapter.embed(['hola']);

    expect(seen[0]?.init?.headers).not.toMatchObject({ authorization: expect.anything() });
  });

  it('batches large inputs and preserves order', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new OpenAiCompatibleEmbeddingAdapter(
      { ...BASE_CONFIG, batchSize: 2 },
      recordSeen(seen),
    );

    const vectors = await adapter.embed(['a', 'b', 'c']);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.body.input).toEqual(['a', 'b']);
    expect(seen[1]?.body.input).toEqual(['c']);
    expect(vectors).toEqual([
      [0.5, 1.5, 2.5, 3.5],
      [4.5, 5.5, 6.5, 7.5],
      [0.5, 1.5, 2.5, 3.5],
    ]);
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let calls = 0;
    const seen: SeenRequest[] = [];
    const fetchImpl: EmbeddingFetch = (_input, init) => {
      calls += 1;
      seen.push({ url: 'u', init, body: bodyOf(init) });
      if (calls === 1) {
        return Promise.resolve(
          jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '0' }),
        );
      }
      return Promise.resolve(jsonResponse(200, embeddingPayload(1, DIM)));
    };
    const adapter = new OpenAiCompatibleEmbeddingAdapter(BASE_CONFIG, fetchImpl);

    const vectors = await adapter.embed(['hola']);

    expect(calls).toBe(2);
    expect(vectors).toEqual([[0.5, 1.5, 2.5, 3.5]]);
  });

  it('retries 500s and gives up with a normalized server error', async () => {
    const fetchImpl: EmbeddingFetch = () => Promise.resolve(jsonResponse(500, { error: 'boom' }));
    const adapter = new OpenAiCompatibleEmbeddingAdapter(
      { ...BASE_CONFIG, maxAttempts: 2 },
      fetchImpl,
    );

    const error = await adapter.embed(['hola']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('server');
    expect((error as AiProviderError).retryable).toBe(true);
    expect((error as AiProviderError).message).not.toContain('hola');
  });

  it('maps 401 to a non-retryable auth error without retrying', async () => {
    const fetchMock = vi.fn<EmbeddingFetch>(() =>
      Promise.resolve(jsonResponse(401, { error: 'bad key' })),
    );
    const adapter = new OpenAiCompatibleEmbeddingAdapter(BASE_CONFIG, fetchMock);

    const error = await adapter.embed(['hola']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('auth');
    expect((error as AiProviderError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects vectors with unexpected dimensions instead of persisting them', async () => {
    const fetchImpl: EmbeddingFetch = () =>
      Promise.resolve(jsonResponse(200, embeddingPayload(1, DIM + 1)));
    const adapter = new OpenAiCompatibleEmbeddingAdapter(BASE_CONFIG, fetchImpl);

    const error = await adapter.embed(['hola']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('bad_request');
  });

  it('maps aborts to a retryable timeout error', async () => {
    const hanging: EmbeddingFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const adapter = new OpenAiCompatibleEmbeddingAdapter(
      { ...BASE_CONFIG, timeoutMs: 10, maxAttempts: 1 },
      hanging,
    );

    const error = await adapter.embed(['hola']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('timeout');
    expect((error as AiProviderError).retryable).toBe(true);
  });

  it('sends no HTTP for an empty input', async () => {
    const fetchMock = vi.fn<EmbeddingFetch>(() =>
      Promise.resolve(jsonResponse(200, embeddingPayload(0, DIM))),
    );
    const adapter = new OpenAiCompatibleEmbeddingAdapter(BASE_CONFIG, fetchMock);

    await expect(adapter.embed([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid configuration without network', () => {
    expect(() => new OpenAiCompatibleEmbeddingAdapter({ ...BASE_CONFIG, baseUrl: '' })).toThrow(
      /EMBEDDING_BASE_URL/,
    );
    expect(
      () => new OpenAiCompatibleEmbeddingAdapter({ ...BASE_CONFIG, baseUrl: 'ftp://x' }),
    ).toThrow(/EMBEDDING_BASE_URL/);
    expect(() => new OpenAiCompatibleEmbeddingAdapter({ ...BASE_CONFIG, model: '' })).toThrow(
      /EMBEDDING_MODEL/,
    );
  });
});
