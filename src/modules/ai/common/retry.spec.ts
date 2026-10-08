import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, parseRetryAfterMs, withRetry } from './retry.js';

const POLICY = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  it('parses HTTP dates relative to now', () => {
    const now = Date.parse('2026-10-08T00:00:00.000Z');
    const later = 'Wed, 08 Oct 2026 00:00:03 GMT';
    expect(parseRetryAfterMs(later, now)).toBe(3000);
  });

  it('returns undefined for missing or garbage values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon-ish')).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('doubles per attempt and caps at maxDelayMs', () => {
    expect(backoffDelayMs(1, POLICY)).toBe(500);
    expect(backoffDelayMs(2, POLICY)).toBe(1000);
    expect(backoffDelayMs(3, POLICY)).toBe(2000);
    expect(backoffDelayMs(10, POLICY)).toBe(8000);
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(
      () => Promise.resolve('ok'),
      () => ({ retryable: true }),
      POLICY,
      { sleepMs: sleep, jitterMs: () => 0 },
    );

    expect(result).toEqual({ value: 'ok', attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries retryable failures with exponential backoff', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('boom-500')) : Promise.resolve('recovered');
      },
      () => ({ retryable: true }),
      POLICY,
      { sleepMs: sleep, jitterMs: () => 0 },
    );

    expect(result).toEqual({ value: 'recovered', attempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it('honors retryAfterMs over the computed backoff', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await withRetry(
      () => {
        calls += 1;
        return calls < 2 ? Promise.reject(new Error('limited')) : Promise.resolve('ok');
      },
      () => ({ retryable: true, retryAfterMs: 250 }),
      POLICY,
      { sleepMs: sleep, jitterMs: () => 0 },
    );

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not retry non-retryable failures', async () => {
    const sleep = vi.fn(async () => {});
    const failure = new Error('bad-credentials');
    await expect(
      withRetry(
        () => Promise.reject(failure),
        () => ({ retryable: false }),
        POLICY,
        { sleepMs: sleep, jitterMs: () => 0 },
      ),
    ).rejects.toBe(failure);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxAttempts', async () => {
    const sleep = vi.fn(async () => {});
    const failure = new Error('flaky');
    await expect(
      withRetry(
        () => Promise.reject(failure),
        () => ({ retryable: true }),
        POLICY,
        {
          sleepMs: sleep,
          jitterMs: () => 0,
        },
      ),
    ).rejects.toBe(failure);
    expect(sleep).toHaveBeenCalledTimes(POLICY.maxAttempts - 1);
  });
});
