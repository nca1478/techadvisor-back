import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../ai-provider.error.js';
import {
  OpenAiCompatibleLlmAdapter,
  type LlmFetch,
  type OpenAiCompatibleLlmConfig,
} from './openai-compatible-llm.adapter.js';

const BASE_CONFIG: OpenAiCompatibleLlmConfig = {
  baseUrl: 'https://llm.example.com/v1/',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 5000,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
  defaultMaxTokens: 64,
};

const REQ = { system: 'Be brief.', messages: [{ role: 'user' as const, content: 'Hi' }] };

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

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function chatPayload(text: string, withUsage = true): unknown {
  return {
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content: text } }],
    ...(withUsage ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}),
  };
}

function sseStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('OpenAiCompatibleLlmAdapter', () => {
  it('posts system + messages with bearer auth and parses text + usage', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: LlmFetch = (input, init) => {
      seen.push({ url: urlOf(input), init });
      return Promise.resolve(jsonResponse(200, chatPayload('hello there')));
    };
    const adapter = new OpenAiCompatibleLlmAdapter(BASE_CONFIG, fetchImpl);

    const result = await adapter.generate(REQ);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://llm.example.com/v1/chat/completions');
    const body = JSON.parse(seen[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 64,
      stream: false,
    });
    expect(seen[0]?.init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(result.text).toBe('hello there');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  it('omits the auth header when no api key is configured', async () => {
    const seen: { init: RequestInit | undefined }[] = [];
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...BASE_CONFIG, apiKey: undefined },
      (input, init) => {
        seen.push({ init });
        return Promise.resolve(jsonResponse(200, chatPayload('hi')));
      },
    );

    await adapter.generate(REQ);

    expect(seen[0]?.init?.headers).not.toMatchObject({ authorization: expect.anything() });
  });

  it('streams SSE deltas across chunk splits until [DONE]', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n: keep-alive\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAiCompatibleLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(sseStreamResponse(sse)),
    );

    const parts: string[] = [];
    for await (const delta of adapter.stream(REQ)) {
      parts.push(delta);
    }

    expect(parts.join('')).toBe('hello world');
  });

  it('ignores non-delta SSE lines and empty deltas', async () => {
    const sse =
      `: comment\n\n` +
      `event: ping\ndata: {"ping":true}\n\n` +
      sseData({ choices: [{ delta: {} }] }) +
      sseData({ choices: [{ delta: { content: 'ok' } }] }) +
      `data: [DONE]\n\n`;
    const adapter = new OpenAiCompatibleLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(sseStreamResponse([sse])),
    );

    const parts: string[] = [];
    for await (const delta of adapter.stream(REQ)) {
      parts.push(delta);
    }

    expect(parts).toEqual(['ok']);
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let calls = 0;
    const adapter = new OpenAiCompatibleLlmAdapter(BASE_CONFIG, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(jsonResponse(429, { error: 'slow down' }, { 'retry-after': '0' }));
      }
      return Promise.resolve(jsonResponse(200, chatPayload('recovered')));
    });

    const result = await adapter.generate(REQ);

    expect(calls).toBe(2);
    expect(result.text).toBe('recovered');
  });

  it('maps 401 to a non-retryable auth error without retrying', async () => {
    const fetchMock = vi.fn<LlmFetch>(() => Promise.resolve(jsonResponse(401, { error: 'bad' })));
    const adapter = new OpenAiCompatibleLlmAdapter(BASE_CONFIG, fetchMock);

    const error = await adapter.generate(REQ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('auth');
    expect((error as AiProviderError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 500s and gives up with a normalized error that hides the prompt', async () => {
    const adapter = new OpenAiCompatibleLlmAdapter({ ...BASE_CONFIG, maxAttempts: 2 }, () =>
      Promise.resolve(jsonResponse(500, { error: 'boom' })),
    );

    const error = await adapter
      .generate({ system: 's', messages: [{ role: 'user', content: 'secret-question' }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('server');
    expect((error as AiProviderError).retryable).toBe(true);
    expect((error as AiProviderError).message).not.toContain('secret-question');
  });

  it('leaves usage undefined when the provider omits it', async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(200, chatPayload('plain', false))),
    );

    const result = await adapter.generate(REQ);

    expect(result.text).toBe('plain');
    expect(result.usage).toBeUndefined();
  });

  it('rejects invalid configuration without network', () => {
    expect(() => new OpenAiCompatibleLlmAdapter({ ...BASE_CONFIG, baseUrl: '' })).toThrow(
      /LLM_BASE_URL/,
    );
    expect(() => new OpenAiCompatibleLlmAdapter({ ...BASE_CONFIG, baseUrl: 'ftp://x' })).toThrow(
      /LLM_BASE_URL/,
    );
    expect(() => new OpenAiCompatibleLlmAdapter({ ...BASE_CONFIG, model: '' })).toThrow(
      /LLM_MODEL/,
    );
  });
});
