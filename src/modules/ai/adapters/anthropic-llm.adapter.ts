import Anthropic from '@anthropic-ai/sdk';
import { AiConfigError, AiProviderError, AiRateLimitError } from '../ai-provider.error.js';
import { withRetry } from '../common/retry.js';
import type {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../interfaces/llm-provider.interface.js';

/**
 * Native adapter for the Anthropic Messages API via the official
 * `@anthropic-ai/sdk` (default native LLM provider, see ADR 0024).
 *
 * The generic OpenAI-compatible adapter cannot cover this provider (own
 * auth scheme, `system` as a top-level field, `max_tokens` required,
 * content-block responses, SDK-managed SSE) — so this file exists
 * alongside it, still the only place (with its sibling adapters) allowed
 * to import a provider SDK. Everything else depends on `LlmProvider`.
 *
 * `clientFactory` is injectable so tests run fully offline with a stub;
 * production uses the real SDK client. Failures normalize to
 * `AiProviderError` codes; messages never carry prompt text or keys.
 */

export interface AnthropicLlmConfig {
  apiKey: string | undefined;
  /** Optional override (tests, proxies); defaults to api.anthropic.com. */
  baseUrl: string | undefined;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  defaultMaxTokens: number;
}

interface AnthropicTextBlock {
  type: string;
  text?: unknown;
}

interface AnthropicMessageResult {
  content: AnthropicTextBlock[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** Minimal surface of the SDK client this adapter needs (structural). */
export interface AnthropicLlmClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResult>;
    stream(params: Record<string, unknown>): AsyncIterable<unknown>;
  };
}

export type AnthropicClientFactory = () => AnthropicLlmClient;

function defaultClientFactory(config: AnthropicLlmConfig): AnthropicLlmClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined && config.baseUrl !== '' ? { baseURL: config.baseUrl } : {}),
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
  // The SDK client structurally satisfies the minimal interface above.
  return client as unknown as AnthropicLlmClient;
}

export class AnthropicLlmAdapter implements LlmProvider {
  readonly providerName = 'anthropic';
  readonly model: string;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultMaxTokens: number;
  private readonly clientFactory: AnthropicClientFactory;

  constructor(config: AnthropicLlmConfig, clientFactory?: AnthropicClientFactory) {
    if (config.model.trim() === '') {
      throw new AiConfigError('LLM_MODEL is required', 'anthropic');
    }
    if (config.baseUrl !== undefined && config.baseUrl.trim() !== '') {
      try {
        const parsed = new URL(config.baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new AiConfigError('LLM_BASE_URL must be an http(s) URL', 'anthropic');
        }
      } catch (error) {
        if (error instanceof AiConfigError) {
          throw error;
        }
        throw new AiConfigError('LLM_BASE_URL must be a valid URL', 'anthropic');
      }
    }
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs;
    this.maxAttempts = config.maxAttempts;
    this.baseDelayMs = config.baseDelayMs;
    this.maxDelayMs = config.maxDelayMs;
    this.defaultMaxTokens = config.defaultMaxTokens;
    this.clientFactory =
      clientFactory ??
      (() =>
        defaultClientFactory({
          apiKey: this.apiKey,
          baseUrl: this.baseUrl,
          model: this.model,
          timeoutMs: this.timeoutMs,
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          defaultMaxTokens: this.defaultMaxTokens,
        }));
  }

  async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const startedAt = Date.now();
    const params = this.toCreateParams(req);
    const { value: message } = await withRetry(
      () => this.createMessage(params),
      (error) => classifyRetryable(error),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs },
    );
    return {
      text: extractText(message),
      usage: extractUsage(message),
      latencyMs: Date.now() - startedAt,
    };
  }

  async *stream(req: LlmGenerateRequest): AsyncIterable<string> {
    // Retry covers establishing the stream only; mid-stream failures
    // surface as-is, like the OpenAI-compatible adapter.
    const params = this.toCreateParams(req);
    const { value: events } = await withRetry(
      () => this.openStream(params),
      (error) => classifyRetryable(error),
      { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs },
    );
    try {
      for await (const event of events) {
        const delta = extractStreamDelta(event);
        if (delta !== undefined) {
          yield delta;
        }
      }
    } catch (error) {
      throw normalizeSdkError(error, this.providerName);
    }
  }

  private async createMessage(params: Record<string, unknown>): Promise<AnthropicMessageResult> {
    try {
      return await this.clientFactory().messages.create(params);
    } catch (error) {
      throw normalizeSdkError(error, this.providerName);
    }
  }

  private openStream(params: Record<string, unknown>): Promise<AsyncIterable<unknown>> {
    try {
      return Promise.resolve(this.clientFactory().messages.stream(params));
    } catch (error) {
      throw normalizeSdkError(error, this.providerName);
    }
  }

  private toCreateParams(req: LlmGenerateRequest): Record<string, unknown> {
    return {
      model: this.model,
      system: req.system,
      messages: req.messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  }
}

function extractText(message: AnthropicMessageResult): string {
  const parts = message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  if (parts.length === 0) {
    throw new AiProviderError(
      'server',
      'Chat provider returned a response without text',
      'anthropic',
    );
  }
  return parts.join('');
}

function extractUsage(message: AnthropicMessageResult): LlmGenerateResult['usage'] {
  const inputTokens =
    typeof message.usage?.input_tokens === 'number' && Number.isFinite(message.usage.input_tokens)
      ? message.usage.input_tokens
      : undefined;
  const outputTokens =
    typeof message.usage?.output_tokens === 'number' && Number.isFinite(message.usage.output_tokens)
      ? message.usage.output_tokens
      : undefined;
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function extractStreamDelta(event: unknown): string | undefined {
  if (event === null || typeof event !== 'object') {
    return undefined;
  }
  const record = event as { type?: unknown; delta?: unknown };
  if (
    record.type !== 'content_block_delta' ||
    record.delta === null ||
    typeof record.delta !== 'object'
  ) {
    return undefined;
  }
  const delta = record.delta as { type?: unknown; text?: unknown };
  return delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== ''
    ? delta.text
    : undefined;
}

/**
 * Normalizes SDK (and transport) failures to `AiProviderError` codes.
 * Reads `status`/headers when present (real `APIError`), falls back to
 * error-name matching for timeouts/connection failures. Never includes
 * prompt text or keys in messages.
 */
export function normalizeSdkError(error: unknown, providerName: string): AiProviderError {
  if (error instanceof AiProviderError) {
    return error;
  }
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    if (typeof status === 'number') {
      return normalizeStatusError(status, providerName, error);
    }
    return new AiProviderError('network', 'Chat request failed', providerName, { cause: error });
  }
  if (error instanceof Error) {
    if (error.name.includes('Timeout') || error.name === 'AbortError') {
      return new AiProviderError('timeout', 'Chat request timed out', providerName, {
        cause: error,
      });
    }
    if (error.name.includes('Connection') || error.name.includes('Network')) {
      return new AiProviderError('network', 'Chat request failed', providerName, { cause: error });
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return normalizeStatusError(status, providerName, error);
    }
  } else if (error !== null && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return normalizeStatusError(status, providerName, error);
    }
  }
  return new AiProviderError('network', 'Chat request failed', providerName, { cause: error });
}

function normalizeStatusError(
  status: number,
  providerName: string,
  cause: unknown,
): AiProviderError {
  if (status === 401 || status === 403) {
    return new AiProviderError('auth', 'Chat provider rejected credentials', providerName, {
      status,
      cause,
    });
  }
  if (status === 429) {
    return new AiRateLimitError('Chat provider rate limited', providerName, { status, cause });
  }
  if (status === 400) {
    return new AiProviderError('bad_request', 'Chat provider rejected the request', providerName, {
      status,
      cause,
    });
  }
  if (status >= 500) {
    return new AiProviderError('server', 'Chat provider returned a server error', providerName, {
      status,
      cause,
    });
  }
  return new AiProviderError('server', 'Chat provider returned an error', providerName, {
    status,
    cause,
  });
}

function classifyRetryable(error: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (error instanceof AiRateLimitError) {
    return { retryable: true, retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof AiProviderError) {
    return { retryable: error.retryable };
  }
  return { retryable: true };
}
