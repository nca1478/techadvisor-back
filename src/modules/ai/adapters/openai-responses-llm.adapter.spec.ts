import { describe, expect, it } from 'vitest';
import { AiProviderError } from '../ai-provider.error.js';
import {
  OpenAiResponsesLlmAdapter,
  type OpenAiResponsesLlmConfig,
  type ResponsesFetch,
} from './openai-responses-llm.adapter.js';

const BASE_CONFIG: OpenAiResponsesLlmConfig = {
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

function responsesPayload(text: string, withUsage = true): unknown {
  return {
    id: 'resp-1',
    output: [
      // Reasoning items carry no answer text and must be skipped.
      { type: 'reasoning', id: 'rs-1', summary: [] },
      {
        type: 'message',
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    ...(withUsage ? { usage: { input_tokens: 10, output_tokens: 5 } } : {}),
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

describe('OpenAiResponsesLlmAdapter', () => {
  it('posts instructions + input with bearer auth and parses text + usage', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: ResponsesFetch = (input, init) => {
      seen.push({ url: urlOf(input), init });
      return Promise.resolve(jsonResponse(200, responsesPayload('hello there')));
    };
    const adapter = new OpenAiResponsesLlmAdapter(BASE_CONFIG, fetchImpl);

    const result = await adapter.generate(REQ);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://llm.example.com/v1/responses');
    const body = JSON.parse(seen[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'test-model',
      instructions: 'Be brief.',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 64,
      stream: false,
    });
    expect(seen[0]?.init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(result.text).toBe('hello there');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  it('omits the auth header when no api key is configured', async () => {
    const seen: { init: RequestInit | undefined }[] = [];
    const adapter = new OpenAiResponsesLlmAdapter(
      { ...BASE_CONFIG, apiKey: undefined },
      (_input, init) => {
        seen.push({ init });
        return Promise.resolve(jsonResponse(200, responsesPayload('hi')));
      },
    );

    await adapter.generate(REQ);

    expect(seen[0]?.init?.headers).not.toMatchObject({ authorization: expect.anything() });
  });

  it('streams output_text deltas across chunk splits until [DONE]', async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"hel',
      'lo"}\n\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n: keep-alive\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(sseStreamResponse(sse)),
    );

    const parts: string[] = [];
    for await (const delta of adapter.stream(REQ)) {
      parts.push(delta);
    }

    expect(parts.join('')).toBe('hello world');
  });

  it('ignores non-text stream events', async () => {
    const sse = [
      sseData({ type: 'response.created' }) +
        sseData({ type: 'response.output_text.delta', delta: 'hi' }) +
        sseData({ type: 'response.completed' }),
    ];
    const adapter = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(sseStreamResponse(sse)),
    );

    const parts: string[] = [];
    for await (const delta of adapter.stream(REQ)) {
      parts.push(delta);
    }

    expect(parts).toEqual(['hi']);
  });

  it('maps 401 to auth and 429 to rate_limited (with retry-after)', async () => {
    const auth = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(401, { error: 'bad key' })),
    );
    const authError = await auth.generate(REQ).catch((error: unknown) => error);
    expect(authError).toBeInstanceOf(AiProviderError);
    expect((authError as AiProviderError).code).toBe('auth');
    expect((authError as AiProviderError).retryable).toBe(false);

    const limited = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(429, { error: 'slow down' }, { 'retry-after': '2' })),
    );
    const limitError = await limited.generate(REQ).catch((error: unknown) => error);
    expect(limitError).toBeInstanceOf(AiProviderError);
    expect((limitError as AiProviderError).code).toBe('rate_limited');
  });

  it('maps 400 to bad_request and 500 to server without leaking prompts', async () => {
    const bad = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(400, { error: 'nope' })),
    );
    const badError = await bad
      .generate({
        system: 'secret-system',
        messages: [{ role: 'user', content: 'secret-question' }],
      })
      .catch((error: unknown) => error);
    expect((badError as AiProviderError).code).toBe('bad_request');
    expect((badError as AiProviderError).message).not.toContain('secret-question');

    const down = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(500, { error: 'boom' })),
    );
    const downError = await down.generate(REQ).catch((error: unknown) => error);
    expect((downError as AiProviderError).code).toBe('server');
  });

  it('rejects responses without answer text as malformed', async () => {
    const empty = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(jsonResponse(200, { id: 'resp-1', output: [] })),
    );
    const error = await empty.generate(REQ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('server');

    const reasoningOnly = new OpenAiResponsesLlmAdapter(BASE_CONFIG, () =>
      Promise.resolve(
        jsonResponse(200, {
          id: 'resp-1',
          output: [{ type: 'reasoning', id: 'rs-1' }],
        }),
      ),
    );
    const reasoningError = await reasoningOnly.generate(REQ).catch((error: unknown) => error);
    expect((reasoningError as AiProviderError).code).toBe('server');
  });

  it('rejects empty baseUrl, non-http URLs and empty models at construction', () => {
    expect(() => new OpenAiResponsesLlmAdapter({ ...BASE_CONFIG, baseUrl: '  ' })).toThrow(
      'LLM_BASE_URL is required',
    );
    expect(() => new OpenAiResponsesLlmAdapter({ ...BASE_CONFIG, baseUrl: 'ftp://x' })).toThrow(
      'LLM_BASE_URL must be an http(s) URL',
    );
    expect(() => new OpenAiResponsesLlmAdapter({ ...BASE_CONFIG, model: '  ' })).toThrow(
      'LLM_MODEL is required',
    );
  });
});
