import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { fromStripeAmount, toStripeAmount } from './stripe-amount.js';
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProvider,
  VerifiedWebhookEvent,
  WebhookOutcome,
} from './payment-provider.js';

/** Credentials for the Stripe adapter (both come from validated env config). */
export interface StripeAdapterConfig {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
  /**
   * Optional API base URL for local development against stripe-mock
   * (e.g. `http://localhost:12111`, see ADR 0051). Unset in normal
   * operation, where the SDK talks to the real Stripe test API.
   */
  baseUrl?: string | undefined;
}

/**
 * Narrow structural view of the Stripe SDK surface this adapter uses. The
 * production instance is the real SDK; tests inject a stub of this shape, so
 * no network is ever needed to exercise checkout creation or event mapping
 * (signature verification itself always runs against the real SDK).
 */
export interface StripeClient {
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        opts?: Stripe.RequestOptions,
      ): Promise<Pick<Stripe.Checkout.Session, 'id' | 'url'>>;
    };
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      header: string | Buffer | string[],
      secret: string,
    ): Stripe.Event;
  };
}

/** Checkout Sessions expire with the order reservation TTL (30 minutes). */
export const CHECKOUT_TTL_SEC = 30 * 60;

/**
 * Splits a `STRIPE_BASE_URL` (e.g. `http://localhost:12111` for stripe-mock,
 * see ADR 0051) into the stripe-node constructor options — the only
 * supported way to point the SDK at a non-Stripe host. Returns `{}` when
 * unset so the SDK uses the real Stripe API. Exported for unit testing.
 */
export function stripeOptionsFromBaseUrl(
  baseUrl: string | undefined,
): Pick<Stripe.StripeConfig, 'host' | 'port' | 'protocol'> {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return {};
  }
  const parsed = new URL(baseUrl);
  const protocol = parsed.protocol.replace(/:$/, '') as 'http' | 'https';
  const port = parsed.port.length > 0 ? Number(parsed.port) : protocol === 'https' ? 443 : 80;
  return { host: parsed.hostname, port, protocol };
}

/**
 * Reads our order id from provider metadata without trusting its shape:
 * foreign or forged events may carry anything (or nothing) here.
 */
function metadataOrderId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') {
    return null;
  }
  const value = (metadata as Record<string, unknown>)['orderId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `PaymentProvider` backed by the official `stripe` SDK (test mode only).
 * This is the ONLY file allowed to import the Stripe SDK: everything else
 * talks to the `PaymentProvider` interface (see ADR 0012).
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly injected: StripeClient | undefined;
  private lazy: StripeClient | undefined;

  constructor(config: StripeAdapterConfig, client?: StripeClient) {
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl;
    this.injected = client;
    if (typeof this.baseUrl === 'string' && this.baseUrl.length > 0) {
      // stripe-mock mode (see ADR 0051): checkout sessions return fixture
      // ids/URLs that are NOT payable — opening one in a browser shows
      // Stripe's "This link is incomplete" page. This is expected offline
      // behaviour; unset STRIPE_BASE_URL to use the real test API.
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'Stripe is pointed at a mock base URL: checkout URLs are fixtures, not payable links',
          baseUrl: this.baseUrl,
        }),
      );
    }
  }

  /**
   * The SDK client is built lazily so an unconfigured instance (no keys in
   * local development/CI) never touches the SDK constructor at module init.
   * When `baseUrl` is set (stripe-mock via docker compose, see ADR 0051),
   * it is split into the SDK's `host`/`port`/`protocol` options — the only
   * supported way to point stripe-node at a non-Stripe host.
   */
  private get client(): StripeClient {
    if (this.lazy === undefined) {
      // The official SDK structurally satisfies the narrow StripeClient view.
      this.lazy = this.injected ?? new Stripe(this.secretKey ?? '', this.stripeOptions());
    }
    return this.lazy;
  }

  private stripeOptions(): Stripe.StripeConfig {
    return stripeOptionsFromBaseUrl(this.baseUrl);
  }

  isConfigured(): boolean {
    return (
      typeof this.secretKey === 'string' &&
      this.secretKey.length > 0 &&
      typeof this.webhookSecret === 'string' &&
      this.webhookSecret.length > 0
    );
  }

  async createPayment(
    req: CreatePaymentRequest,
    idempotencyKey: string,
  ): Promise<CreatePaymentResult> {
    this.assertConfigured();
    const expectedTotal = req.lines.reduce(
      (sum, line) => sum + line.unitAmountMinor * line.quantity,
      0,
    );
    if (expectedTotal !== req.totalAmountMinor) {
      // Internal bug (prices always come from the DB): fail loudly, never
      // send a mismatched amount to Stripe.
      throw new Error(
        `Refusing to create a Stripe session: lines total ${String(expectedTotal)} != order total ${String(req.totalAmountMinor)}`,
      );
    }
    const currency = req.currency.toLowerCase();
    const session = await this.client.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: req.orderId,
        metadata: { orderId: req.orderId },
        line_items: req.lines.map((line) => ({
          quantity: line.quantity,
          price_data: {
            currency,
            unit_amount: toStripeAmount(line.unitAmountMinor, req.currency),
            product_data: { name: line.name },
          },
        })),
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SEC,
      },
      { idempotencyKey },
    );
    return { provider: this.name, sessionId: session.id, checkoutUrl: session.url };
  }

  parseAndVerifyWebhook(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): VerifiedWebhookEvent {
    if (typeof this.webhookSecret !== 'string' || this.webhookSecret.length === 0) {
      throw new ServiceUnavailableException('Payment webhooks are not configured');
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new BadRequestException({ message: 'Missing stripe-signature header' });
    }
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new BadRequestException({ message: 'Invalid webhook signature or payload' });
    }
    if (event.livemode) {
      // This codebase runs test mode only (ADR 0012): never apply live events.
      throw new BadRequestException({ message: 'Live-mode events are not accepted' });
    }
    return this.toVerifiedEvent(event);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('Payments are not configured');
    }
  }

  private toVerifiedEvent(event: Stripe.Event): VerifiedWebhookEvent {
    const base = { id: event.id, provider: this.name } as const;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return { ...base, ...this.fromSession(event.data.object), outcome: 'succeeded' };
      case 'checkout.session.expired':
        return { ...base, ...this.fromSession(event.data.object), outcome: 'expired' };
      case 'checkout.session.async_payment_failed':
        return { ...base, ...this.fromSession(event.data.object), outcome: 'failed' };
      case 'payment_intent.succeeded':
        return { ...base, ...this.fromPaymentIntent(event.data.object), outcome: 'succeeded' };
      case 'payment_intent.payment_failed':
        return { ...base, ...this.fromPaymentIntent(event.data.object), outcome: 'failed' };
      case 'payment_intent.canceled':
        // Abandoned before collection: same handling as an expiry.
        return { ...base, ...this.fromPaymentIntent(event.data.object), outcome: 'expired' };
      default:
        return {
          ...base,
          outcome: 'ignored',
          orderId: null,
          externalRef: null,
          amountMinor: null,
          currency: null,
        };
    }
  }

  private fromSession(
    object: Stripe.Event.Data.Object,
  ): Omit<VerifiedWebhookEvent, 'id' | 'provider' | 'outcome'> {
    const session = object as Stripe.Checkout.Session;
    return {
      orderId: session.client_reference_id ?? metadataOrderId(session.metadata),
      externalRef: session.id,
      ...this.toMinor(session.amount_total, session.currency),
    };
  }

  private fromPaymentIntent(
    object: Stripe.Event.Data.Object,
  ): Omit<VerifiedWebhookEvent, 'id' | 'provider' | 'outcome'> {
    const intent = object as Stripe.PaymentIntent;
    const amount = intent.amount_received > 0 ? intent.amount_received : intent.amount;
    return {
      orderId: metadataOrderId(intent.metadata),
      externalRef: intent.id,
      ...this.toMinor(amount, intent.currency),
    };
  }

  private toMinor(
    amount: number | null,
    currency: string | null,
  ): Pick<VerifiedWebhookEvent, 'amountMinor' | 'currency'> {
    if (typeof amount !== 'number' || typeof currency !== 'string') {
      return { amountMinor: null, currency: null };
    }
    try {
      return { amountMinor: fromStripeAmount(amount, currency), currency: currency.toUpperCase() };
    } catch {
      // Unrepresentable amount (e.g. ISK not on a whole unit): report the
      // currency but no amount, so the service skips the transition.
      return { amountMinor: null, currency: currency.toUpperCase() };
    }
  }
}

export type { WebhookOutcome };
