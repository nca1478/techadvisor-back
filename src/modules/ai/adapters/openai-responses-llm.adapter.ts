import { randomUUID } from 'node:crypto';
import { AiConfigError, AiProviderError, AiRateLimitError } from '../ai-provider.error.js';
import { parseRetryAfterMs, withRetry } from '../common/retry.js';
import type {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../interfaces/llm-provider.interface.js';

/**
 * Generic adapter for any HTTP API exposing the OpenAI Responses format
 * (`POST /responses`): OpenAI itself, Azure OpenAI, Vercel AI Gateway,
 * opencode-go Zen (`https://opencode.ai/zen/go/v1`), …
 *
 * The system prompt travels in `instructions` (plain text, provider-neutral);
 * the answer text is read from `output[]` message items, skipping
 * non-message items such as `reasoning`. THIS FILE (plus its sibling
 * adapters) is the only place allowed to run provider HTTP: the rest of
 * the codebase talks to `LlmProvider`. `fetchImpl` defaults to the global
 * `fetch` and is injectable so tests run fully offline with a stub. Error
 * messages never carry prompt text or keys; only provider/model/status
 * metadata. Token counts are taken from `usage` when reported.
 */

export interface OpenAiResponsesLlmConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  defaultMaxTokens: number;
  /**
   * Stable session id sent as `x-opencode-session` (required by some
   * gateways, e.g. opencode-go Zen, for routing and prompt caching).
   * Defaults to one UUID per adapter instance (stable for the process
   * lifetime); override only in tests. Never personal data.
   */
  sessionId?: string;
  /**
   * Reasoning effort for thinking models (`minimal`..`high`). Sent only
   * when set — non-reasoning models reject the parameter. Keep unset to
   * use the provider default.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

export type ResponsesFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface OutputTextPart {
  type: unknown;
  text: unknown;
}

function isOutputTextPart(value: unknown): value is OutputTextPart {
  return value !== null && typeof value === 'object';
}

interface OutputItem {
  type?: unknown;
  content?: unknown;
}

interface ResponsesPayload {
  output?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function isOutputItem(value: unknown): value is OutputItem {
  return value !== null && typeof value === 'object';
}

function outputTextOf(item: OutputItem): string {
  if (item.type !== 'message' || !Array.isArray(item.content)) {
    // Reasoning, tool-call and other items carry no answer text.
    return '';
  }
  const parts: string[] = [];
  for (const part of item.content) {
    if (!isOutputTextPart(part) || part.type !== 'output_text') {
      continue;
    }
    if (typeof part.text === 'string' && part.text !== '') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class OpenAiResponsesLlmAdapter implements LlmProvider {
  readonly providerName = 'openai-responses';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultMaxTokens: number;
  private readonly sessionId: string;
  private readonly reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  private readonly fetchImpl: ResponsesFetch;

  constructor(config: OpenAiResponsesLlmConfig, fetchImpl?: ResponsesFetch) {
    if (config.baseUrl.trim() === '') {
      throw new AiConfigError('LLM_BASE_URL is required', 'openai-responses');
    }
    try {
      const parsed = new URL(config.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiConfigError('LLM_BASE_URL must be an http(s) URL', 'openai-responses');
      }
    } catch (error) {
      if (error instanceof AiConfigError) {
        throw error;
      }
      throw new AiConfigError('LLM_BASE_URL must be a valid URL', 'openai-responses');
    }
    if (config.model.trim() === '') {
      throw new AiConfigError('LLM_MODEL is required', 'openai-responses');
    }
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.maxAttempts = config.maxAttempts;
    this.baseDelayMs = config.baseDelayMs;
    this.maxDelayMs = config.maxDelayMs;
    this.defaultMaxTokens = config.defaultMaxTokens;
    this.sessionId =
      config.sessionId !== undefined && config.sessionId.trim() !== ''
        ? config.sessionId
        : randomUUID();
    this.reasoningEffort = config.reasoningEffort;
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const startedAt = Date.now();
    const { value: response } = await withRetry(
      () => this.postResponses(req, false),
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
      () => this.postResponses(req, true),
      (error) => classifyRetry(error),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs },
    );
    yield* parseSseDeltas(response);
  }

  private async postResponses(req: LlmGenerateRequest, stream: boolean): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, '/responses'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Stable per-instance id: required by session-aware gateways
          // (opencode-go Zen rejects requests without it) and improves
          // routing affinity and prompt caching server-side.
          'x-opencode-session': this.sessionId,
          ...(this.apiKey !== undefined && this.apiKey !== ''
            ? { authorization: `Bearer ${this.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.model,
          instructions: req.system,
          input: req.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          // Covers visible tokens AND reasoning tokens on thinking models.
          max_output_tokens: req.maxTokens ?? this.defaultMaxTokens,
          ...(this.reasoningEffort !== undefined
            ? { reasoning: { effort: this.reasoningEffort } }
            : {}),
          stream,
        }),
        signal: controller.signal,
      });
      throwForResponsesStatus(response, this.providerName);
      return response;
    } catch (error) {
      throw normalizeTransportError(error, this.providerName);
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

function normalizeTransportError(error: unknown, providerName: string): AiProviderError {
  if (error instanceof AiProviderError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new AiProviderError('timeout', 'Responses request timed out', providerName, {
      cause: error,
    });
  }
  return new AiProviderError('network', 'Responses request failed', providerName, {
    cause: error,
  });
}

export function throwForResponsesStatus(response: Response, providerName: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new AiProviderError('auth', 'Responses provider rejected credentials', providerName, {
      status: response.status,
    });
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw new AiRateLimitError('Responses provider rate limited', providerName, {
      status: 429,
      retryAfterMs,
    });
  }
  if (response.status === 400) {
    throw new AiProviderError(
      'bad_request',
      'Responses provider rejected the request',
      providerName,
      {
        status: 400,
      },
    );
  }
  if (response.status >= 500) {
    throw new AiProviderError(
      'server',
      'Responses provider returned a server error',
      providerName,
      {
        status: response.status,
      },
    );
  }
  if (!response.ok) {
    throw new AiProviderError('server', 'Responses provider returned an error', providerName, {
      status: response.status,
    });
  }
}

export function extractTextFromPayload(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || !('output' in payload)) {
    throw new AiProviderError(
      'server',
      'Responses provider returned a malformed response',
      'openai-responses',
    );
  }
  const output = (payload as ResponsesPayload).output;
  if (!Array.isArray(output) || output.length === 0) {
    throw new AiProviderError(
      'server',
      'Responses provider returned a malformed response',
      'openai-responses',
    );
  }
  const text = output.filter(isOutputItem).map(outputTextOf).join('');
  if (text === '') {
    throw new AiProviderError(
      'server',
      'Responses provider returned a malformed response',
      'openai-responses',
    );
  }
  return text;
}

export function extractUsage(payload: unknown): LlmGenerateResult['usage'] {
  if (payload === null || typeof payload !== 'object' || !('usage' in payload)) {
    return undefined;
  }
  const usage = (payload as ResponsesPayload).usage;
  const inputTokens = toFiniteNumber(usage?.input_tokens);
  const outputTokens = toFiniteNumber(usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

/**
 * Minimal SSE parser for Responses `response.output_text.delta` events.
 * Skips comments, `[DONE]` and non-JSON keep-alives; tolerates chunk
 * splits at arbitrary byte boundaries.
 */
export async function* parseSseDeltas(response: Response): AsyncIterable<string> {
  if (response.body === null) {
    throw new AiProviderError(
      'server',
      'Responses provider returned an empty stream',
      'openai-responses',
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
  if (event === null || typeof event !== 'object') {
    return undefined;
  }
  const record = event as { type?: unknown; delta?: unknown };
  if (record.type !== 'response.output_text.delta' || typeof record.delta !== 'string') {
    return undefined;
  }
  return record.delta === '' ? undefined : record.delta;
}
