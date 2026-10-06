/**
 * Payment provider abstraction (see ADR 0012).
 *
 * The rest of the codebase depends only on this interface: swapping Stripe
 * for another provider (or adding PaymentIntent alongside Checkout) means a
 * new implementation of `PaymentProvider`, never changes to the orders or
 * payments service logic. Provider SDKs are imported only inside the
 * concrete adapter file (`stripe-payment.provider.ts`).
 */

/** NestJS injection token for the configured `PaymentProvider`. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** One frozen order line, priced server-side in the order currency. */
export interface PaymentLine {
  name: string;
  unitAmountMinor: number;
  quantity: number;
}

/** Everything the provider needs to start a checkout; money is pre-resolved. */
export interface CreatePaymentRequest {
  orderId: string;
  /** ISO 4217 code of `totalAmountMinor` and every line. */
  currency: string;
  /** Frozen order total in minor units — never taken from the client. */
  totalAmountMinor: number;
  lines: PaymentLine[];
  /** Display-only redirect targets; they never change order state. */
  successUrl: string;
  cancelUrl: string;
}

export interface CreatePaymentResult {
  provider: string;
  /** Provider-side session/payment id, stored as `Payment.externalRef`. */
  sessionId: string;
  /** Hosted checkout URL for the frontend redirect (null when unavailable). */
  checkoutUrl: string | null;
}

/** Normalized outcome of a verified webhook event. */
export type WebhookOutcome = 'succeeded' | 'failed' | 'expired' | 'ignored';

export interface VerifiedWebhookEvent {
  /** Provider event id (`evt_...`): the idempotency key. */
  id: string;
  provider: string;
  outcome: WebhookOutcome;
  /** Our order id from the provider metadata (null when absent). */
  orderId: string | null;
  /** Provider-side session/payment id (`Payment.externalRef`). */
  externalRef: string | null;
  /** Collected amount in our ISO minor units (null when not reported). */
  amountMinor: number | null;
  /** ISO 4217 code of `amountMinor` (null when not reported). */
  currency: string | null;
}

export interface PaymentProvider {
  /** Provider key stored in `payments.provider` (e.g. `'stripe'`). */
  readonly name: string;
  /** False when credentials are missing: the service then returns 503. */
  isConfigured(): boolean;
  /**
   * Starts a hosted checkout for an already-priced order.
   * `idempotencyKey` is derived from the order id, so retries replay the
   * same provider-side session instead of charging twice.
   */
  createPayment(req: CreatePaymentRequest, idempotencyKey: string): Promise<CreatePaymentResult>;
  /**
   * Verifies the provider signature over the RAW request body and returns
   * the normalized event. Throws a 400 `BadRequestException` when the
   * signature is missing or invalid — the controller then changes nothing.
   */
  parseAndVerifyWebhook(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): VerifiedWebhookEvent;
}
