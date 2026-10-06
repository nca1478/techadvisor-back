import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import type { CreatePaymentRequest } from './payment-provider.js';
import {
  CHECKOUT_TTL_SEC,
  StripePaymentProvider,
  type StripeClient,
} from './stripe-payment.provider.js';

const WEBHOOK_SECRET = 'whsec_unit_test_secret';
const SECRET_KEY = 'sk_test_unit';

function realWebhooks(): Stripe['webhooks'] {
  return new Stripe(SECRET_KEY).webhooks;
}

interface SeenCreate {
  params: Stripe.Checkout.SessionCreateParams;
  opts?: Stripe.RequestOptions;
}

/** Offline harness: real SDK for signatures, recording stub for checkout. */
function harness(options: { configured?: boolean; sessionId?: string; url?: string } = {}): {
  provider: StripePaymentProvider;
  seen: SeenCreate[];
} {
  const configured = options.configured ?? true;
  const seen: SeenCreate[] = [];
  const stub: StripeClient = {
    checkout: {
      sessions: {
        create: (params, opts): Promise<Pick<Stripe.Checkout.Session, 'id' | 'url'>> => {
          seen.push({ params, opts });
          return Promise.resolve({
            id: options.sessionId ?? 'cs_test_123',
            url: options.url ?? 'https://checkout.stripe.com/pay/cs_test_123',
          });
        },
      },
    },
    webhooks: {
      constructEvent: (payload, header, secret): Stripe.Event =>
        realWebhooks().constructEvent(payload, header, secret),
    },
  };
  const provider = new StripePaymentProvider(
    {
      secretKey: configured ? SECRET_KEY : undefined,
      webhookSecret: configured ? WEBHOOK_SECRET : undefined,
    },
    stub,
  );
  return { provider, seen };
}

function sign(payload: string, secret: string = WEBHOOK_SECRET): string {
  return realWebhooks().generateTestHeaderString({ payload, secret });
}

function sessionEvent(
  type: string,
  session: Record<string, unknown>,
  eventId = 'evt_test_1',
): { raw: string; signature: string } {
  const raw = JSON.stringify({
    id: eventId,
    object: 'event',
    api_version: '2026-10-06',
    created: Math.floor(Date.now() / 1000),
    data: { object: { object: 'checkout.session', ...session } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_1', idempotency_key: null },
    type,
  });
  return { raw, signature: sign(raw) };
}

function paymentIntentEvent(
  type: string,
  intent: Record<string, unknown>,
  eventId = 'evt_test_pi_1',
): { raw: string; signature: string } {
  const raw = JSON.stringify({
    id: eventId,
    object: 'event',
    api_version: '2026-10-06',
    created: Math.floor(Date.now() / 1000),
    data: { object: { object: 'payment_intent', ...intent } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_1', idempotency_key: null },
    type,
  });
  return { raw, signature: sign(raw) };
}

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

const CHECKOUT_REQUEST: CreatePaymentRequest = {
  orderId: ORDER_ID,
  currency: 'EUR',
  totalAmountMinor: 180_00,
  lines: [{ name: 'Test Laptop', unitAmountMinor: 90_00, quantity: 2 }],
  successUrl: 'http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: `http://localhost:3000/checkout/cancel?orderId=${ORDER_ID}`,
};

describe('StripePaymentProvider', () => {
  it('reports unconfigured without keys and refuses to work (503)', async () => {
    const { provider } = harness({ configured: false });

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.createPayment(CHECKOUT_REQUEST, 'checkout-x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(() => provider.parseAndVerifyWebhook('{}', 'sig')).toThrow(ServiceUnavailableException);
  });

  it('creates a Checkout Session from DB prices with the order idempotency key', async () => {
    const { provider, seen } = harness();
    const before = Math.floor(Date.now() / 1000);

    const result = await provider.createPayment(CHECKOUT_REQUEST, `checkout-${ORDER_ID}`);

    expect(result).toEqual({
      provider: 'stripe',
      sessionId: 'cs_test_123',
      checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_123',
    });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call.opts).toMatchObject({ idempotencyKey: `checkout-${ORDER_ID}` });
    expect(call.params.mode).toBe('payment');
    expect(call.params.client_reference_id).toBe(ORDER_ID);
    expect(call.params.metadata).toMatchObject({ orderId: ORDER_ID });
    expect(call.params.line_items).toHaveLength(1);
    expect(call.params.line_items?.[0]).toMatchObject({
      quantity: 2,
      price_data: { currency: 'eur', unit_amount: 90_00 },
    });
    const expiresAt = call.params.expires_at;
    expect(typeof expiresAt).toBe('number');
    expect(expiresAt ?? 0).toBeGreaterThanOrEqual(before + CHECKOUT_TTL_SEC - 5);
  });

  it('refuses a request whose lines do not add up to the order total', async () => {
    const { provider, seen } = harness();

    await expect(
      provider.createPayment({ ...CHECKOUT_REQUEST, totalAmountMinor: 1 }, 'checkout-x'),
    ).rejects.toThrow(/lines total/);
    expect(seen).toHaveLength(0);
  });

  it('rejects a missing signature (400)', () => {
    const { provider } = harness();

    expect(() => provider.parseAndVerifyWebhook('{}', undefined)).toThrow(BadRequestException);
  });

  it('rejects a forged signature (400)', () => {
    const { provider } = harness();
    const { raw } = sessionEvent('checkout.session.completed', {
      id: 'cs_test_123',
      amount_total: 180_00,
      currency: 'eur',
      client_reference_id: ORDER_ID,
      metadata: { orderId: ORDER_ID },
    });

    expect(() => provider.parseAndVerifyWebhook(raw, sign(raw, 'whsec_wrong'))).toThrow(
      BadRequestException,
    );
  });

  it('rejects live-mode events even with a valid signature (test mode only)', () => {
    const { provider } = harness();
    const raw = JSON.stringify({
      id: 'evt_live',
      object: 'event',
      api_version: '2026-10-06',
      created: Math.floor(Date.now() / 1000),
      data: { object: { object: 'checkout.session', id: 'cs_live' } },
      livemode: true,
      pending_webhooks: 1,
      request: { id: 'req_1', idempotency_key: null },
      type: 'checkout.session.completed',
    });

    expect(() => provider.parseAndVerifyWebhook(raw, sign(raw))).toThrow(BadRequestException);
  });

  it('maps checkout.session.completed to succeeded with DB minor units', () => {
    const { provider } = harness();
    const { raw, signature } = sessionEvent('checkout.session.completed', {
      id: 'cs_test_123',
      amount_total: 180_00,
      currency: 'eur',
      client_reference_id: ORDER_ID,
      metadata: { orderId: ORDER_ID },
    });

    expect(provider.parseAndVerifyWebhook(raw, signature)).toEqual({
      id: 'evt_test_1',
      provider: 'stripe',
      outcome: 'succeeded',
      orderId: ORDER_ID,
      externalRef: 'cs_test_123',
      amountMinor: 180_00,
      currency: 'EUR',
    });
  });

  it('maps session expiry and async failures to expired/failed', () => {
    const { provider } = harness();
    const session = {
      id: 'cs_test_123',
      amount_total: 180_00,
      currency: 'usd',
      client_reference_id: ORDER_ID,
      metadata: { orderId: ORDER_ID },
    };

    for (const [type, outcome] of [
      ['checkout.session.expired', 'expired'],
      ['checkout.session.async_payment_failed', 'failed'],
      ['checkout.session.async_payment_succeeded', 'succeeded'],
    ] as const) {
      const { raw, signature } = sessionEvent(type, session, `evt_${type}`);
      expect(provider.parseAndVerifyWebhook(raw, signature)).toMatchObject({
        outcome,
        orderId: ORDER_ID,
      });
    }
  });

  it('maps payment_intent events via metadata (received preferred over amount)', () => {
    const { provider } = harness();
    const ok = paymentIntentEvent('payment_intent.succeeded', {
      id: 'pi_test_1',
      amount: 100_00,
      amount_received: 100_00,
      currency: 'usd',
      metadata: { orderId: ORDER_ID },
    });
    expect(provider.parseAndVerifyWebhook(ok.raw, ok.signature)).toMatchObject({
      outcome: 'succeeded',
      orderId: ORDER_ID,
      externalRef: 'pi_test_1',
      amountMinor: 100_00,
      currency: 'USD',
    });

    const failed = paymentIntentEvent(
      'payment_intent.payment_failed',
      { id: 'pi_test_2', amount: 50_00, amount_received: 0, currency: 'usd', metadata: {} },
      'evt_pi_failed',
    );
    expect(provider.parseAndVerifyWebhook(failed.raw, failed.signature)).toMatchObject({
      outcome: 'failed',
      orderId: null,
    });

    const canceled = paymentIntentEvent(
      'payment_intent.canceled',
      { id: 'pi_test_3', amount: 50_00, amount_received: 0, currency: 'usd', metadata: {} },
      'evt_pi_canceled',
    );
    expect(provider.parseAndVerifyWebhook(canceled.raw, canceled.signature)).toMatchObject({
      outcome: 'expired',
    });
  });

  it('ignores unrelated event types but still reports the event id', () => {
    const { provider } = harness();
    const { raw, signature } = sessionEvent('charge.refunded', { id: 'ch_1' }, 'evt_other');

    expect(provider.parseAndVerifyWebhook(raw, signature)).toEqual({
      id: 'evt_other',
      provider: 'stripe',
      outcome: 'ignored',
      orderId: null,
      externalRef: null,
      amountMinor: null,
      currency: null,
    });
  });

  it('uses the injected stub client instead of the network (spy check)', async () => {
    const create = vi.fn(() =>
      Promise.resolve({ id: 'cs_spy', url: null } as Pick<Stripe.Checkout.Session, 'id' | 'url'>),
    );
    const provider = new StripePaymentProvider(
      { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET },
      {
        checkout: { sessions: { create } },
        webhooks: {
          constructEvent: (p, h, s): Stripe.Event => realWebhooks().constructEvent(p, h, s),
        },
      },
    );

    await provider.createPayment(CHECKOUT_REQUEST, 'checkout-spy');
    expect(create).toHaveBeenCalledOnce();
  });
});
