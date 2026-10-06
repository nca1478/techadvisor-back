/**
 * Single conversion point between our money representation (integer ISO 4217
 * minor units, see ADR 0007) and Stripe's `amount` field (see ADR 0012).
 *
 * Rule source: https://docs.stripe.com/currencies — Stripe expects amounts
 * in the currency's minor unit, two-decimal unless listed as zero-decimal.
 * Our database already stores ISO minor units, so for almost every currency
 * this function is the identity; only Stripe's documented quirks differ:
 *
 * - Zero-decimal (amount IS the major unit): identity.
 * - `ISK` / `UGX`: Stripe requires the legacy two-decimal form
 *   (`major × 100`, decimals always `00`), so stored whole units × 100.
 * - `HUF` / `TWD`: charged as normal two-decimal amounts (their
 *   zero-decimal treatment is payouts-only): identity.
 * - Three-decimal (`BHD`, `JOD`, `KWD`, `OMR`, `TND`): amounts are
 *   thousandths but Stripe requires the last digit to be `0`, so values
 *   round to the nearest multiple of 10 minor units (half up).
 *
 * No other code may convert amounts for Stripe.
 */

const ISO_CODE_PATTERN = /^[A-Z]{3}$/;

/** Stripe zero-decimal currencies (docs.stripe.com/currencies, 2026-10-06). */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/**
 * Currencies Stripe charges in legacy two-decimal form despite having no
 * ISO minor unit. Stored whole units are scaled by 100 on the way out.
 */
const LEGACY_TWO_DECIMAL = new Set(['ISK', 'UGX']);

/** ISO 4217 three-decimal currencies supported by Stripe with rounding. */
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

function assertValidInput(amountMinor: number, currency: string): string {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`amountMinor must be a non-negative integer, got ${String(amountMinor)}`);
  }
  const code = currency.toUpperCase();
  if (!ISO_CODE_PATTERN.test(code)) {
    throw new RangeError(`currency must be a 3-letter ISO 4217 code, got "${currency}"`);
  }
  return code;
}

/**
 * Converts an integer ISO-4217 minor-unit amount to the integer Stripe
 * expects in its `amount` field for `currency`.
 */
export function toStripeAmount(amountMinor: number, currency: string): number {
  const code = assertValidInput(amountMinor, currency);
  if (ZERO_DECIMAL.has(code)) {
    return amountMinor;
  }
  if (LEGACY_TWO_DECIMAL.has(code)) {
    return amountMinor * 100;
  }
  if (THREE_DECIMAL.has(code)) {
    // Round half up to the nearest multiple of 10 (last digit must be 0).
    return Math.floor((amountMinor + 5) / 10) * 10;
  }
  return amountMinor;
}

/**
 * Exact inverse of `toStripeAmount`, used to interpret amounts arriving in
 * webhooks back into our ISO minor units. Throws when the Stripe amount
 * cannot represent a valid stored amount (e.g. `ISK` not divisible by 100).
 */
export function fromStripeAmount(stripeAmount: number, currency: string): number {
  const code = assertValidInput(stripeAmount, currency);
  if (LEGACY_TWO_DECIMAL.has(code)) {
    if (stripeAmount % 100 !== 0) {
      throw new RangeError(
        `Stripe amount ${String(stripeAmount)} ${code} is not divisible by 100 (ISK/UGX decimals must be 00)`,
      );
    }
    return stripeAmount / 100;
  }
  return stripeAmount;
}
