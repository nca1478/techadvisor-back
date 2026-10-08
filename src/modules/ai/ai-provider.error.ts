/**
 * Normalized AI provider errors (see ADR 0016).
 *
 * Every adapter translates transport/provider failures into these types so
 * consumers (ingestion jobs, retrieval) never branch on provider-specific
 * shapes. `retryable` tells the caller whether a retry/backoff is sensible.
 * Error messages never include input texts or API keys.
 */

export type AiErrorCode =
  'auth' | 'rate_limited' | 'timeout' | 'bad_request' | 'server' | 'network' | 'config';

const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set([
  'rate_limited',
  'timeout',
  'server',
  'network',
]);

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    code: AiErrorCode,
    message: string,
    provider: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.provider = provider;
    this.retryable = RETRYABLE_CODES.has(code);
    this.status = options.status;
    // Keep the low-level cause for logs without leaking it to API responses.
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class AiConfigError extends AiProviderError {
  constructor(message: string, provider: string) {
    super('config', message, provider);
    this.name = 'AiConfigError';
  }
}

export class AiRateLimitError extends AiProviderError {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    provider: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super('rate_limited', message, provider, options);
    this.name = 'AiRateLimitError';
    this.retryAfterMs = options.retryAfterMs;
  }
}
