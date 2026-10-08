/**
 * Retry helper with exponential backoff and jitter, shared by AI adapters.
 *
 * Retries only failures the operation classifies as retryable (429/5xx for
 * HTTP embeddings). Honors `retryAfterMs` (e.g. from a `Retry-After`
 * header) when present. Pure apart from the injectable `sleepMs`/`now`
 * hooks, which tests override for determinism (no real timers, no network).
 */

export interface RetryPolicy {
  /** Max attempts including the first one (must be >= 1). */
  maxAttempts: number;
  /** Base delay before the first retry; doubles on each subsequent retry. */
  baseDelayMs: number;
  /** Upper bound for any single backoff delay. */
  maxDelayMs: number;
}

export interface RetryOperationResult<T> {
  value: T;
  attempts: number;
}

export interface RetryableFailure {
  retryable: boolean;
  retryAfterMs?: number;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs?: number,
): number | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    const base = nowMs ?? Date.now();
    return Math.max(0, at - base);
  }
  return undefined;
}

export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  // attempt is 1-based (delay before attempt 2 uses attempt === 1).
  const grown = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(grown, policy.maxDelayMs);
}

/**
 * Runs `operation`, retrying while `classify` marks the failure retryable
 * and attempts remain. `onRetry` receives (error, delayMs, nextAttempt) for
 * observability — adapters keep it free of input texts and secrets.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  classify: (error: unknown) => RetryableFailure,
  policy: RetryPolicy,
  hooks: {
    sleepMs?: (ms: number) => Promise<void>;
    jitterMs?: () => number;
    onRetry?: (error: unknown, delayMs: number, nextAttempt: number) => void;
  } = {},
): Promise<RetryOperationResult<T>> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be an integer >= 1, got ${String(policy.maxAttempts)}`);
  }
  const sleep =
    hooks.sleepMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const jitter = hooks.jitterMs ?? ((): number => Math.floor(Math.random() * 100));

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      const verdict = classify(error);
      if (!verdict.retryable || attempt >= policy.maxAttempts) {
        throw error;
      }
      const delay = Math.min(
        (verdict.retryAfterMs ?? backoffDelayMs(attempt, policy)) + Math.max(0, jitter()),
        policy.maxDelayMs,
      );
      hooks.onRetry?.(error, delay, attempt + 1);
      await sleep(delay);
    }
  }
  throw lastError;
}
