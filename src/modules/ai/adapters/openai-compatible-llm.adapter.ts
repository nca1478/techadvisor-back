import { AiConfigError, AiProviderError, AiRateLimitError } from '../ai-provider.error.js';
import { parseRetryAfterMs, withRetry } from '../common/retry.js';
import type {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../interfaces/llm-provider.interface.js';

/**
 * Generic chat adapter for any HTTP API exposing the OpenAI
 * `/chat/completions` JSON format (OpenAI itself, OpenRouter, vLLM,
 * Ollama, …), with SSE streaming.
 *
 * THIS FILE (plus its sibling adapters) is the only place allowed to run
 * provider HTTP: the rest of the codebase talks to `LlmProvider`.
 * `fetchImpl` defaults to the global `fetch` and is injectable so tests run
 * fully offline with a stub. Error messages never carry prompt text or keys;
 * only provider/model/status metadata. Token counts are taken from `usage`
 * when the server reports them.
 */

export interface OpenAiCompatibleLlmConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  defaultMaxTokens: number;
}

export type LlmFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ChatChoiceMessage {
  content: unknown;
}

interface ChatCompletionPayload {
  choices: { message?: ChatChoiceMessage }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function isChatCompletionPayload(value: unknown): value is ChatCompletionPayload {
  if (value === null || typeof value !== 'object' || !('choices' in value)) {
    return false;
  }
  return Array.isArray(value.choices);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class OpenAiCompatibleLlmAdapter implements LlmProvider {
  readonly providerName = 'openai-compatible';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultMaxTokens: number;
  private readonly fetchImpl: LlmFetch;

  constructor(config: OpenAiCompatibleLlmConfig, fetchImpl?: LlmFetch) {
    if (config.baseUrl.trim() === '') {
      throw new AiConfigError('LLM_BASE_URL is required', 'openai-compatible');
    }
    try {
      const parsed = new URL(config.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiConfigError('LLM_BASE_URL must be an http(s) URL', 'openai-compatible');
      }
    } catch (error) {
      if (error instanceof AiConfigError) {
        throw error;
      }
      throw new AiConfigError('LLM_BASE_URL must be a valid URL', 'openai-compatible');
    }
    if (config.model.trim() === '') {
      throw new AiConfigError('LLM_MODEL is required', 'openai-compatible');
    }
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.maxAttempts = config.maxAttempts;
    this.baseDelayMs = config.baseDelayMs;
    this.maxDelayMs = config.maxDelayMs;
    this.defaultMaxTokens = config.defaultMaxTokens;
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const startedAt = Date.now();
    const { value: response } = await withRetry(
      () => this.postChat(req, false),
      (error) => classifyRetry(error),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs },
    );
    const payload: unknown = await response.json();
    return {
      text: extractTextFromPayload(payload),
      usage: extractUsage(payload),
      latencyMs: Date.now() - startedAt,
    };
  }

  async *stream(req: LlmGenerateRequest): AsyncIterable<string> {
    // Retry covers establishing the SSE stream only; once bytes flow,
    // mid-stream failures surface as-is (no silent re-request with a
    // half-consumed prompt).
    const { value: response } = await withRetry(
      () => this.postChat(req, true),
      (error) => classifyRetry(error),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs },
    );
    yield* parseSseDeltas(response);
  }

  private async postChat(req: LlmGenerateRequest, stream: boolean): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey !== undefined && this.apiKey !== ''
            ? { authorization: `Bearer ${this.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            ...req.messages.map((message) => ({ role: message.role, content: message.content })),
          ],
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          max_tokens: req.maxTokens ?? this.defaultMaxTokens,
          stream,
        }),
        signal: controller.signal,
      });
      throwForStatus(response, this.providerName, 'Chat');
      return response;
    } catch (error) {
      throw normalizeTransportError(error, this.providerName, 'Chat');
    } finally {
      clearTimeout(timer);
    }
  }
}

function classifyRetry(error: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (error instanceof AiRateLimitError) {
    return { retryable: true, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof AiProviderError) {
    return { retryable: error.retryable };
  }
  return { retryable: true };
}

function normalizeTransportError(
  error: unknown,
  providerName: string,
  what: string,
): AiProviderError {
  if (error instanceof AiProviderError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new AiProviderError('timeout', `${what} request timed out`, providerName, {
      cause: error,
    });
  }
  return new AiProviderError('network', `${what} request failed`, providerName, {
    cause: error,
  });
}

export function throwForStatus(response: Response, providerName: string, what: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new AiProviderError('auth', `${what} provider rejected credentials`, providerName, {
      status: response.status,
    });
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw new AiRateLimitError(`${what} provider rate limited`, providerName, {
      status: 429,
      retryAfterMs,
    });
  }
  if (response.status === 400) {
    throw new AiProviderError(
      'bad_request',
      `${what} provider rejected the request`,
      providerName,
      {
        status: 400,
      },
    );
  }
  if (response.status >= 500) {
    throw new AiProviderError('server', `${what} provider returned a server error`, providerName, {
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new AiProviderError('server', `${what} provider returned an error`, providerName, {
      status: response.status,
    });
  }
}

export function extractTextFromPayload(payload: unknown): string {
  if (!isChatCompletionPayload(payload) || payload.choices.length === 0) {
    throw new AiProviderError(
      'server',
      'Chat provider returned a malformed response',
      'openai-compatible',
    );
  }
  const content = payload.choices[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new AiProviderError(
      'server',
      'Chat provider returned a malformed response',
      'openai-compatible',
    );
  }
  return content;
}

export function extractUsage(payload: unknown): LlmGenerateResult['usage'] {
  if (payload === null || typeof payload !== 'object' || !('usage' in payload)) {
    return undefined;
  }
  const usage = (payload as ChatCompletionPayload).usage;
  const inputTokens = toFiniteNumber(usage?.prompt_tokens);
  const outputTokens = toFiniteNumber(usage?.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

/**
 * Minimal SSE parser for `text/event-stream` chat deltas. Handles `data:`
 * lines (including multi-line data payloads), skips comments/`[DONE]`,
 * and tolerates chunk splits at arbitrary byte boundaries.
 */
export async function* parseSseDeltas(response: Response): AsyncIterable<string> {
  if (response.body === null) {
    throw new AiProviderError(
      'server',
      'Chat provider returned an empty stream',
      'openai-compatible',
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        const delta = parseSseLine(line);
        if (delta !== undefined) {
          yield delta;
        }
        boundary = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      const delta = parseSseLine(buffer.trim());
      if (delta !== undefined) {
        yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) {
    return undefined;
  }
  if (!trimmed.startsWith('data:')) {
    return undefined;
  }
  const data = trimmed.slice('data:'.length).trim();
  if (data === '[DONE]') {
    return undefined;
  }
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    // Providers may send keep-alive or non-JSON data lines; ignore them.
    return undefined;
  }
  if (event === null || typeof event !== 'object' || !('choices' in event)) {
    return undefined;
  }
  const choices: unknown = event.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const delta = (choices[0] as { delta?: { content?: unknown } }).delta?.content;
  return typeof delta === 'string' && delta !== '' ? delta : undefined;
}
