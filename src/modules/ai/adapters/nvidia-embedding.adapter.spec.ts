import { describe, expect, it, vi } from 'vitest';
import { AiProviderError, AiRateLimitError } from '../ai-provider.error.js';
import {
  NvidiaEmbeddingAdapter,
  type NvidiaEmbeddingConfig,
  type NvidiaEmbeddingFetch,
} from './nvidia-embedding.adapter.js';

/** Native dim of nvidia/nemotron-3-embed-1b (ADR 0018). */
const DIM = 2048;

const BASE_CONFIG: NvidiaEmbeddingConfig = {
  baseUrl: 'https://integrate.api.nvidia.com/v1/',
  apiKey: 'nvapi-test',
  model: 'nvidia/nemotron-3-embed-1b',
  dimensions: DIM,
  batchSize: 100,
  timeoutMs: 5000,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
};

interface SeenBody {
  input: string[];
  model: string;
  input_type: string;
  modality: string;
}

interface SeenRequest {
  url: string;
  init: RequestInit | undefined;
  body: SeenBody & Record<string, unknown>;
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
      embedding: Array.from({ length: dim }, (_, d) => (i * dim + d + 0.5) / dim),
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

function recordSeen(seen: SeenRequest[]): NvidiaEmbeddingFetch {
  return (input, init) => {
    if (typeof init?.body !== 'string') {
      throw new Error('expected a JSON string body');
    }
    const body = JSON.parse(init.body) as SeenBody & Record<string, unknown>;
    seen.push({ url: urlOf(input), init, body });
    return Promise.resolve(jsonResponse(200, embeddingPayload(body.input.length, DIM)));
  };
}

describe('NvidiaEmbeddingAdapter', () => {
  it('posts input_type passage + modality text and NEVER dimensions', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, recordSeen(seen));

    const vectors = await adapter.embed(['hola mundo']);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://integrate.api.nvidia.com/v1/embeddings');
    expect(seen[0]?.body.input).toEqual(['hola mundo']);
    expect(seen[0]?.body.model).toBe('nvidia/nemotron-3-embed-1b');
    expect(seen[0]?.body.input_type).toBe('passage');
    expect(seen[0]?.body.modality).toBe('text');
    expect(seen[0]?.body).not.toHaveProperty('dimensions');
    expect(seen[0]?.init?.headers).toMatchObject({ authorization: 'Bearer nvapi-test' });
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(DIM);
  });

  it('sends input_type query when kind is query', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, recordSeen(seen));

    await adapter.embed(['¿qué portátil compro?'], { kind: 'query' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.input_type).toBe('query');
  });

  it('sends input_type passage for explicit document kind', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, recordSeen(seen));

    await adapter.embed(['manual del producto'], { kind: 'document' });

    expect(seen[0]?.body.input_type).toBe('passage');
  });

  it('batches large inputs and preserves order', async () => {
    const seen: SeenRequest[] = [];
    const adapter = new NvidiaEmbeddingAdapter({ ...BASE_CONFIG, batchSize: 2 }, recordSeen(seen));

    const vectors = await adapter.embed(['a', 'b', 'c']);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.body.input).toEqual(['a', 'b']);
    expect(seen[1]?.body.input).toEqual(['c']);
    // Same stub payload per batch: batch 2 restarts at index 0.
    expect(vectors[0]).toEqual(vectors[2]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it('returns an empty list without any request for empty input', async () => {
    const fetchImpl = vi.fn<NvidiaEmbeddingFetch>();
    const adapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, fetchImpl);

    await expect(adapter.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails loudly on wrong-length vectors instead of mixing dimensions', async () => {
    const adapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(200, embeddingPayload(1, 1536))),
    );

    const error = await adapter.embed(['hola']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('bad_request');
  });

  it('normalizes auth/rate-limit/bad-request statuses', async () => {
    const authAdapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(401, { message: 'nope' })),
    );
    await expect(authAdapter.embed(['hola'])).rejects.toMatchObject({ code: 'auth' });

    const badAdapter = new NvidiaEmbeddingAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(400, { message: 'nope' })),
    );
    await expect(badAdapter.embed(['hola'])).rejects.toMatchObject({ code: 'bad_request' });

    const limitedAdapter = new NvidiaEmbeddingAdapter({ ...BASE_CONFIG, maxAttempts: 1 }, () =>
      Promise.resolve(jsonResponse(429, { message: 'slow' })),
    );
    const error = await limitedAdapter.embed(['hola']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiRateLimitError);
  });

  it('rejects empty base url, model and non-positive dimensions at construction', () => {
    expect(() => new NvidiaEmbeddingAdapter({ ...BASE_CONFIG, baseUrl: '  ' })).toThrow(
      /EMBEDDING_BASE_URL/,
    );
    expect(() => new NvidiaEmbeddingAdapter({ ...BASE_CONFIG, model: '' })).toThrow(
      /EMBEDDING_MODEL/,
    );
    expect(() => new NvidiaEmbeddingAdapter({ ...BASE_CONFIG, dimensions: 0 })).toThrow(
      /EMBEDDING_DIM/,
    );
  });
});
