import { describe, expect, it } from 'vitest';
import { fromStripeAmount, toStripeAmount } from './stripe-amount.js';

describe('toStripeAmount', () => {
  it('is the identity for two-decimal currencies (USD, EUR)', () => {
    expect(toStripeAmount(1000, 'USD')).toBe(1000);
    expect(toStripeAmount(90_00, 'EUR')).toBe(90_00);
    expect(toStripeAmount(0, 'USD')).toBe(0);
  });

  it('accepts lowercase codes (Stripe requires lowercase on the wire)', () => {
    expect(toStripeAmount(1000, 'usd')).toBe(1000);
  });

  it('is the identity for zero-decimal currencies (amount IS the major unit)', () => {
    expect(toStripeAmount(500, 'JPY')).toBe(500);
    expect(toStripeAmount(1000, 'KRW')).toBe(1000);
    expect(toStripeAmount(10, 'VND')).toBe(10);
    expect(toStripeAmount(250, 'CLP')).toBe(250);
  });

  it('scales ISK/UGX by 100 (Stripe legacy two-decimal representation)', () => {
    // 5 ISK charged as 500 (decimals always 00).
    expect(toStripeAmount(5, 'ISK')).toBe(500);
    expect(toStripeAmount(5, 'UGX')).toBe(500);
  });

  it('treats HUF/TWD as normal two-decimal charges (payout quirk does not apply)', () => {
    expect(toStripeAmount(1045, 'HUF')).toBe(1045);
    expect(toStripeAmount(80045, 'TWD')).toBe(80045);
  });

  it('rounds three-decimal currencies to a multiple of 10 (last digit 0)', () => {
    // 5.124 KWD -> 5120; 5.125 KWD -> 5130 (half up); exact stays.
    expect(toStripeAmount(5124, 'KWD')).toBe(5120);
    expect(toStripeAmount(5125, 'KWD')).toBe(5130);
    expect(toStripeAmount(5130, 'BHD')).toBe(5130);
    expect(toStripeAmount(1, 'JOD')).toBe(0);
    expect(toStripeAmount(1005, 'OMR')).toBe(1010);
    expect(toStripeAmount(999, 'TND')).toBe(1000);
  });

  it('rejects negative, fractional or non-numeric amounts', () => {
    expect(() => toStripeAmount(-1, 'USD')).toThrow(RangeError);
    expect(() => toStripeAmount(10.5, 'USD')).toThrow(RangeError);
    expect(() => toStripeAmount(Number.NaN, 'USD')).toThrow(RangeError);
  });

  it('rejects malformed currency codes', () => {
    expect(() => toStripeAmount(100, 'dollar')).toThrow(RangeError);
    expect(() => toStripeAmount(100, 'US')).toThrow(RangeError);
    expect(() => toStripeAmount(100, '')).toThrow(RangeError);
  });
});

describe('fromStripeAmount', () => {
  it('round-trips every supported family', () => {
    expect(fromStripeAmount(toStripeAmount(1000, 'USD'), 'USD')).toBe(1000);
    expect(fromStripeAmount(toStripeAmount(500, 'JPY'), 'JPY')).toBe(500);
    expect(fromStripeAmount(toStripeAmount(5, 'ISK'), 'ISK')).toBe(5);
    expect(fromStripeAmount(toStripeAmount(1045, 'HUF'), 'HUF')).toBe(1045);
  });

  it('rejects ISK/UGX amounts not divisible by 100', () => {
    expect(() => fromStripeAmount(501, 'ISK')).toThrow(RangeError);
    expect(() => fromStripeAmount(550, 'UGX')).toThrow(RangeError);
  });
});
