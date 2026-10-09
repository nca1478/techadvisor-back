import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../ai-provider.error.js';
import {
  AnthropicLlmAdapter,
  type AnthropicClientFactory,
  type AnthropicLlmConfig,
} from './anthropic-llm.adapter.js';

const BASE_CONFIG: AnthropicLlmConfig = {
  apiKey: 'test-key',
  baseUrl: undefined,
  model: 'claude-test',
  timeoutMs: 5000,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
  defaultMaxTokens: 64,
};

const REQ = { system: 'Be brief.', messages: [{ role: 'user' as const, content: 'Hi' }] };

/** SDK-shaped failure carrying an HTTP status (real APIError has `.status`). */
function sdkError(status: number): Error {
  return Object.assign(new Error(`sdk failed with status ${String(status)}`), { status });
}

function stubFactory(client: {
  create: (params: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
  stream: (params: Record<string, unknown>) => AsyncIterable<unknown>;
}): AnthropicClientFactory {
  return () => ({ messages: client });
}

function unusedStream(): AsyncIterable<unknown> {
  const failure = (): Promise<IteratorResult<unknown>> =>
    Promise.reject(new Error('stream not used in this test'));
  return { [Symbol.asyncIterator]: () => ({ next: failure }) };
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const delta of stream) {
    parts.push(delta);
  }
  return parts.join('');
}

describe('AnthropicLlmAdapter', () => {
  it('sends system/model/max_tokens and joins text blocks with usage', async () => {
    const seen: unknown[] = [];
    const adapter = new AnthropicLlmAdapter(
      BASE_CONFIG,
      stubFactory({
        create: (params) => {
          seen.push(params);
          return Promise.resolve({
            content: [{ type: 'text', text: 'hello there' }],
            usage: { input_tokens: 7, output_tokens: 3 },
          });
        },
        stream: () => unusedStream(),
      }),
    );

    const result = await adapter.generate(REQ);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      model: 'claude-test',
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 64,
    });
    expect(result.text).toBe('hello there');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  it('streams text deltas and ignores other events', async () => {
    async function* events(): AsyncIterable<unknown> {
      await Promise.resolve();
      yield { type: 'message_start' };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } };
      yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } };
      yield { type: 'message_stop' };
    }
    const adapter = new AnthropicLlmAdapter(
      BASE_CONFIG,
      stubFactory({
        create: () => Promise.reject(new Error('create not used in this test')),
        stream: () => events(),
      }),
    );

    await expect(collect(adapter.stream(REQ))).resolves.toBe('hello');
  });

  it('retries a 429 from the SDK, then succeeds', async () => {
    let calls = 0;
    const adapter = new AnthropicLlmAdapter(
      BASE_CONFIG,
      stubFactory({
        create: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(sdkError(429));
          }
          return Promise.resolve({
            content: [{ type: 'text', text: 'recovered' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
        stream: () => unusedStream(),
      }),
    );

    const result = await adapter.generate(REQ);

    expect(calls).toBe(2);
    expect(result.text).toBe('recovered');
  });

  it('maps 401 to a non-retryable auth error without retrying', async () => {
    const create = vi.fn(() => Promise.reject(sdkError(401)));
    const adapter = new AnthropicLlmAdapter(
      BASE_CONFIG,
      stubFactory({
        create,
        stream: () => unusedStream(),
      }),
    );

    const error = await adapter.generate(REQ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('auth');
    expect((error as AiProviderError).retryable).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps SDK timeouts to retryable timeout errors hiding the prompt', async () => {
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    const adapter = new AnthropicLlmAdapter(
      { ...BASE_CONFIG, maxAttempts: 1 },
      stubFactory({
        create: () => Promise.reject(timeout),
        stream: () => unusedStream(),
      }),
    );

    const error = await adapter
      .generate({ system: 's', messages: [{ role: 'user', content: 'secret-question' }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('timeout');
    expect((error as AiProviderError).retryable).toBe(true);
    expect((error as AiProviderError).message).not.toContain('secret-question');
  });

  it('fails loudly when the response has no text blocks', async () => {
    const adapter = new AnthropicLlmAdapter(
      { ...BASE_CONFIG, maxAttempts: 1 },
      stubFactory({
        create: () =>
          Promise.resolve({
            content: [{ type: 'tool_use' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        stream: () => unusedStream(),
      }),
    );

    const error = await adapter.generate(REQ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('server');
  });

  it('normalizes mid-stream failures instead of leaking SDK shapes', async () => {
    async function* events(): AsyncIterable<unknown> {
      await Promise.resolve();
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
      throw sdkError(500);
    }
    const adapter = new AnthropicLlmAdapter(
      BASE_CONFIG,
      stubFactory({
        create: () => Promise.reject(new Error('create not used in this test')),
        stream: () => events(),
      }),
    );

    const error = await collect(adapter.stream(REQ)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('server');
  });

  it('rejects invalid configuration without network', () => {
    expect(() => new AnthropicLlmAdapter({ ...BASE_CONFIG, model: '' })).toThrow(/LLM_MODEL/);
    expect(() => new AnthropicLlmAdapter({ ...BASE_CONFIG, baseUrl: 'ftp://x' })).toThrow(
      /LLM_BASE_URL/,
    );
  });
});
