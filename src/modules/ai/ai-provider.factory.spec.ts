import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../config/env.schema.js';
import { FakeEmbeddingAdapter } from './adapters/fake-embedding.adapter.js';
import { NvidiaEmbeddingAdapter } from './adapters/nvidia-embedding.adapter.js';
import { OpenAiCompatibleEmbeddingAdapter } from './adapters/openai-compatible-embedding.adapter.js';
import { AiConfigError } from './ai-provider.error.js';
import { createEmbeddingProvider } from './ai-provider.factory.js';
import type { EmbeddingProvider } from './interfaces/embedding-provider.interface.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  PORT: '3001',
  DATABASE_URL: 'postgresql://techadvisor:techadvisor@localhost:5432/techadvisor?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'change-me-to-a-long-random-secret',
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: 'USD,EUR',
  EMBEDDING_PROVIDER: 'fake',
  EMBEDDING_DIM: '32',
};

/** Consumer written ONCE against the interface — must work with any provider. */
async function consumerEmbed(provider: EmbeddingProvider, text: string): Promise<number[]> {
  const vectors = await provider.embed([text]);
  const vector = vectors.at(0);
  if (vector === undefined || vector.length !== provider.dimensions) {
    throw new Error('Consumer contract violated: vector length must equal provider.dimensions');
  }
  return vector;
}

describe('createEmbeddingProvider', () => {
  it('builds the fake adapter from EMBEDDING_PROVIDER=fake (no network)', async () => {
    const provider = createEmbeddingProvider(parseEnv({ ...VALID_ENV }));

    expect(provider).toBeInstanceOf(FakeEmbeddingAdapter);
    expect(provider.model).toBe('fake-hash-v1');
    expect(provider.dimensions).toBe(32);
    await expect(consumerEmbed(provider, 'hola')).resolves.toHaveLength(32);
  });

  it('builds the openai-compatible adapter from config alone', async () => {
    const provider = createEmbeddingProvider(
      parseEnv({
        ...VALID_ENV,
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'test-model',
        EMBEDDING_BASE_URL: 'https://embeddings.example.com/v1',
        EMBEDDING_DIM: '2',
      }),
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.5], index: 0 }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );

    expect(provider).toBeInstanceOf(OpenAiCompatibleEmbeddingAdapter);
    expect(provider.model).toBe('test-model');
    // Same consumer code, no changes: only the dimensions differ (2 here).
    await expect(consumerEmbed(provider, 'hola')).resolves.toHaveLength(2);
  });

  it('builds the nvidia adapter from config alone (ADR 0018)', async () => {
    const seen: string[] = [];
    const provider = createEmbeddingProvider(
      parseEnv({
        ...VALID_ENV,
        EMBEDDING_PROVIDER: 'nvidia',
        EMBEDDING_MODEL: 'nvidia/nemotron-3-embed-1b',
        EMBEDDING_API_KEY: 'nvapi-test',
        EMBEDDING_BASE_URL: 'https://integrate.api.nvidia.com/v1',
        EMBEDDING_DIM: '2048',
      }),
      (input, init) => {
        if (typeof init?.body === 'string') {
          seen.push(init.body);
        }
        const embedding = Array.from({ length: 2048 }, (_, d) => d / 2048);
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding, index: 0 }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    );

    expect(provider).toBeInstanceOf(NvidiaEmbeddingAdapter);
    expect(provider.model).toBe('nvidia/nemotron-3-embed-1b');
    // Same consumer code, no changes: only the dimensions differ (2048 here).
    await expect(consumerEmbed(provider, 'hola')).resolves.toHaveLength(2048);
    // The native adapter sends input_type (passage by default), never dimensions.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"input_type":"passage"');
    expect(seen[0]).not.toContain('dimensions');
  });

  it('rejects unknown providers instead of silently misbehaving', () => {
    const config = parseEnv({ ...VALID_ENV });
    const hacked = { ...config, EMBEDDING_PROVIDER: 'mystery' };

    expect(() => createEmbeddingProvider(hacked as unknown as ReturnType<typeof parseEnv>)).toThrow(
      AiConfigError,
    );
  });
});
