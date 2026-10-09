import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../config/env.schema.js';
import { AnthropicLlmAdapter } from './adapters/anthropic-llm.adapter.js';
import { FakeLlmAdapter } from './adapters/fake-llm.adapter.js';
import { OpenAiCompatibleLlmAdapter } from './adapters/openai-compatible-llm.adapter.js';
import { OpenAiResponsesLlmAdapter } from './adapters/openai-responses-llm.adapter.js';
import { AiConfigError } from './ai-provider.error.js';
import { createLlmProvider } from './ai-provider.factory.js';
import type { LlmProvider } from './interfaces/llm-provider.interface.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  PORT: '3001',
  DATABASE_URL: 'postgresql://techadvisor:techadvisor@localhost:5432/techadvisor?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'change-me-to-a-long-random-secret',
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: 'USD,EUR',
  LLM_PROVIDER: 'fake',
};

/** Consumer written ONCE against the interface — must work with any provider. */
async function consumerAsk(provider: LlmProvider, question: string): Promise<string> {
  const result = await provider.generate({
    system: 'Answer briefly.',
    messages: [{ role: 'user', content: question }],
  });
  if (result.text.trim() === '') {
    throw new Error('Consumer contract violated: empty answer');
  }
  const parts: string[] = [];
  for await (const delta of provider.stream({
    system: 'Answer briefly.',
    messages: [{ role: 'user', content: question }],
  })) {
    parts.push(delta);
  }
  if (parts.join('').trim() === '') {
    throw new Error('Consumer contract violated: empty stream');
  }
  return result.text;
}

describe('createLlmProvider', () => {
  it('builds the fake adapter from LLM_PROVIDER=fake (no network)', async () => {
    const provider = createLlmProvider(parseEnv({ ...VALID_ENV }));

    expect(provider).toBeInstanceOf(FakeLlmAdapter);
    await expect(consumerAsk(provider, 'hola')).resolves.toContain('fake response');
  });

  it('builds the openai-compatible adapter from config alone', async () => {
    const provider = createLlmProvider(
      parseEnv({
        ...VALID_ENV,
        LLM_PROVIDER: 'openai-compatible',
        LLM_MODEL: 'test-chat-model',
        LLM_API_KEY: 'sk-test',
        LLM_BASE_URL: 'https://llm.example.com/v1',
      }),
      (input, init) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        if (body.stream === true) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"hello from http"}}]}\n\n'),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'hello from http' } }],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    );

    expect(provider).toBeInstanceOf(OpenAiCompatibleLlmAdapter);
    expect(provider.model).toBe('test-chat-model');
    // Same consumer code, no changes.
    await expect(consumerAsk(provider, 'hola')).resolves.toContain('hello from http');
  });

  it('builds the anthropic adapter from config alone (ADR 0024)', async () => {
    const seen: unknown[] = [];
    const provider = createLlmProvider(
      parseEnv({
        ...VALID_ENV,
        LLM_PROVIDER: 'anthropic',
        LLM_MODEL: 'claude-test',
        LLM_API_KEY: 'sk-ant-test',
      }),
      undefined,
      () => ({
        messages: {
          create: (params: Record<string, unknown>) => {
            seen.push(params);
            return Promise.resolve({
              content: [{ type: 'text', text: 'hello from sdk' }],
              usage: { input_tokens: 4, output_tokens: 2 },
            });
          },
          stream: () => {
            async function* events(): AsyncIterable<unknown> {
              await Promise.resolve();
              yield {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'hello from sdk' },
              };
            }
            return events();
          },
        },
      }),
    );

    expect(provider).toBeInstanceOf(AnthropicLlmAdapter);
    expect(provider.model).toBe('claude-test');
    // Same consumer code, no changes.
    await expect(consumerAsk(provider, 'hola')).resolves.toContain('hello from sdk');
    expect(seen[0]).toMatchObject({ model: 'claude-test', system: 'Answer briefly.' });
  });

  it('builds the openai-responses adapter from config alone', async () => {
    const provider = createLlmProvider(
      parseEnv({
        ...VALID_ENV,
        LLM_PROVIDER: 'openai-responses',
        LLM_MODEL: 'muse-spark-1.3-contributor',
        LLM_API_KEY: 'zen-test-key',
        LLM_BASE_URL: 'https://opencode.ai/zen/go/v1',
      }),
      (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        expect(url).toBe('https://opencode.ai/zen/go/v1/responses');
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        if (body.stream === true) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.output_text.delta","delta":"hello from responses"}\n\n',
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'resp-1',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'hello from responses' }],
                },
              ],
              usage: { input_tokens: 3, output_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    );

    expect(provider).toBeInstanceOf(OpenAiResponsesLlmAdapter);
    expect(provider.model).toBe('muse-spark-1.3-contributor');
    // Same consumer code, no changes.
    await expect(consumerAsk(provider, 'hola')).resolves.toContain('hello from responses');
  });

  it('rejects unknown providers instead of silently misbehaving', () => {
    const config = parseEnv({ ...VALID_ENV });
    const hacked = { ...config, LLM_PROVIDER: 'mystery' };

    expect(() => createLlmProvider(hacked as unknown as ReturnType<typeof parseEnv>)).toThrow(
      AiConfigError,
    );
  });
});
