import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import Stripe from 'stripe';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../src/modules/payments/payment-provider.js';
import { StripePaymentProvider } from '../src/modules/payments/stripe-payment.provider.js';
import { createTestApp } from './test-app.js';

const TEST_WEBHOOK_SECRET = 'whsec_e2e_test_secret_12345';

/**
 * Offline payment double: checkout is faked (no network, but the request it
 * receives is asserted — totals come from the DB, idempotency key from the
 * order), while webhook parsing delegates to the REAL Stripe adapter so
 * signatures, livemode rejection and event mapping are genuinely verified.
 */
class FakePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  calls: { orderId: string; totalAmountMinor: number; key: string }[] = [];

  private readonly verifier = new StripePaymentProvider({
    secretKey: 'sk_test_e2e_fake',
    webhookSecret: TEST_WEBHOOK_SECRET,
  });

  isConfigured(): boolean {
    return true;
  }

  createPayment(
    req: { orderId: string; totalAmountMinor: number },
    idempotencyKey: string,
  ): Promise<{ provider: string; sessionId: string; checkoutUrl: string | null }> {
    const callNumber = this.calls.length + 1;
    const sessionId = `cs_test_${String(callNumber)}`;
    this.calls.push({
      orderId: req.orderId,
      totalAmountMinor: req.totalAmountMinor,
      key: idempotencyKey,
    });
    return Promise.resolve({
      provider: 'stripe',
      sessionId,
      checkoutUrl: `https://checkout.stripe.test/pay/${sessionId}`,
    });
  }

  parseAndVerifyWebhook(rawBody: Buffer | string, signature: string | undefined) {
    return this.verifier.parseAndVerifyWebhook(rawBody, signature);
  }
}

function stripe(): Stripe {
  return new Stripe('sk_test_e2e_fake');
}

function sessionPayload(
  eventId: string,
  type: string,
  session: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: eventId,
    object: 'event',
    api_version: '2026-10-06',
    created: Math.floor(Date.now() / 1000),
    data: { object: { object: 'checkout.session', ...session } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_1', idempotency_key: null },
    type,
  };
}

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: FakePaymentProvider;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  let productId = '';
  let brandId = '';
  let categoryId = '';
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const shipping = {
    fullName: 'Ada Lovelace',
    line1: 'Calle Mayor 1, 2º B',
    city: 'Madrid',
    country: 'ES',
  };

  async function register(emailPrefix: string): Promise<{ userId: string; token: string }> {
    const email = `e2e-pay-${emailPrefix}-${suffix}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'long-enough-password' })
      .expect(201);
    const userId = (registered.body as { user: { id: string } }).user.id;
    const token = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;
    createdUserIds.push(userId);
    return { userId, token };
  }

  /** Creates a PENDING_PAYMENT order for `qty` units of the fixture product. */
  async function createOrder(token: string, qty: number): Promise<{ id: string; total: number }> {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, qty })
      .expect(201);
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(201);
    const order = created.body as { id: string; totalAmount: number };
    createdOrderIds.push(order.id);
    return { id: order.id, total: order.totalAmount };
  }

  async function postWebhook(
    payload: Record<string, unknown>,
    signature: string,
  ): Promise<{ status: number; body: unknown }> {
    const raw = JSON.stringify(payload);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(raw);
    return { status: res.status, body: res.body };
  }

  function signed(payload: Record<string, unknown>): { raw: string; signature: string } {
    const raw = JSON.stringify(payload);
    const signature = stripe().webhooks.generateTestHeaderString({
      payload: raw,
      secret: TEST_WEBHOOK_SECRET,
    });
    return { raw, signature };
  }

  async function orderStatus(orderId: string, token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (res.body as { status: string }).status;
  }

  async function inventory(): Promise<{ stock: number; reserved: number }> {
    const row = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    return { stock: row.stock, reserved: row.reserved };
  }

  beforeAll(async () => {
    payments = new FakePaymentProvider();
    const ctx = await createTestApp([{ token: PAYMENT_PROVIDER, useValue: payments }]);
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);

    const brand = await prisma.brand.create({
      data: { name: `E2E Pay Brand ${suffix}`, slug: `e2e-pay-brand-${suffix}` },
    });
    brandId = brand.id;
    const category = await prisma.category.create({
      data: { name: `E2E Pay Category ${suffix}`, slug: `e2e-pay-cat-${suffix}` },
    });
    categoryId = category.id;
    const product = await prisma.product.create({
      data: {
        sku: `E2E-PAY-${suffix}`,
        name: `E2E Pay Product ${suffix}`,
        slug: `e2e-pay-${suffix}`,
        description: 'payments fixture',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        inventory: { create: { stock: 10, reserved: 0 } },
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.processedWebhookEvent.deleteMany({
      where: { eventId: { startsWith: 'evt_e2e_pay' } },
    });
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await app.close();
  });

  it('requires authentication and a valid owned PENDING_PAYMENT order for checkout', async () => {
    const server = app.getHttpServer();
    const { token } = await register('auth');
    const other = await register('other');

    await request(server).post('/api/v1/payments/checkout').send({}).expect(401);
    await request(server)
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
    await request(server)
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: 'not-a-uuid' })
      .expect(400);
    // Unknown order and another user's order are indistinguishable (404).
    await request(server)
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: '33333333-3333-4333-8333-333333333333' })
      .expect(404);

    const { id } = await createOrder(token, 1);
    await request(server)
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ orderId: id })
      .expect(404);
    // Clean up: cancel so the reservation does not leak into later tests.
    await request(server)
      .post(`/api/v1/orders/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('starts checkout from DB prices with an order-derived idempotency key', async () => {
    const { token } = await register('checkout');
    const { id, total } = await createOrder(token, 2);
    expect(total).toBe(200_00);

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: id })
      .expect(201);

    const body = res.body as { provider: string; sessionId: string; checkoutUrl: string };
    expect(body.provider).toBe('stripe');
    expect(body.sessionId).toMatch(/^cs_test_/);
    expect(body.checkoutUrl).toContain(body.sessionId);

    // The provider saw the server-side total, never a client amount.
    const last = payments.calls[payments.calls.length - 1];
    expect(last).toMatchObject({ orderId: id, totalAmountMinor: 200_00, key: `checkout-${id}` });

    const payment = await prisma.payment.findFirst({
      where: { orderId: id, provider: 'stripe' },
    });
    expect(payment).toMatchObject({ status: 'PENDING', externalRef: body.sessionId });
  });

  it('rejects a webhook with an invalid signature (400) and changes nothing', async () => {
    const { token } = await register('badsig');
    const { id } = await createOrder(token, 1);
    const before = await inventory();
    const payload = sessionPayload(`evt_e2e_pay_bad_${suffix}`, 'checkout.session.completed', {
      id: 'cs_test_bad',
      amount_total: 100_00,
      currency: 'usd',
      client_reference_id: id,
      metadata: { orderId: id },
    });

    const { status } = await postWebhook(payload, 't=123,v1=deadbeef');
    expect(status).toBe(400);
    expect(await orderStatus(id, token)).toBe('PENDING_PAYMENT');
    expect(await inventory()).toEqual(before);
    // justificado: aserción aislada por eventId; el conteo global es frágil
    // ante eventos residuales de otras corridas/workers que comparten la BD.
    expect(
      await prisma.processedWebhookEvent.findUnique({
        where: { eventId: `evt_e2e_pay_bad_${suffix}` },
      }),
    ).toBeNull();
  });

  it('moves the order to PAID on a verified checkout.session.completed', async () => {
    const { token } = await register('paid');
    const { id, total } = await createOrder(token, 2);
    const before = await inventory();

    const checkout = await request(app.getHttpServer())
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: id })
      .expect(201);
    const sessionId = (checkout.body as { sessionId: string }).sessionId;

    const payload = sessionPayload(`evt_e2e_pay_ok_${suffix}`, 'checkout.session.completed', {
      id: sessionId,
      amount_total: total,
      currency: 'usd',
      client_reference_id: id,
      metadata: { orderId: id },
    });
    const { raw, signature } = signed(payload);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(raw)
      .expect(200);
    expect(res.body).toEqual({ received: true });

    expect(await orderStatus(id, token)).toBe('PAID');
    // Stock committed: the reservation becomes a sale (both decrease by 2).
    expect(await inventory()).toEqual({ stock: before.stock - 2, reserved: before.reserved - 2 });
    const payment = await prisma.payment.findFirst({
      where: { orderId: id, provider: 'stripe' },
    });
    expect(payment).toMatchObject({ status: 'SUCCEEDED', externalRef: sessionId });

    // A redelivered event is acknowledged without repeating side effects.
    const repeat = await request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(raw)
      .expect(200);
    expect(repeat.body).toEqual({ received: true });
    expect(await orderStatus(id, token)).toBe('PAID');
    expect(await inventory()).toEqual({ stock: before.stock - 2, reserved: before.reserved - 2 });
    expect(await prisma.payment.count({ where: { orderId: id, provider: 'stripe' } })).toBe(1);

    // Paying an already-PAID order is an invalid transition (422), never a
    // second charge: state changes come from the webhook only.
    await request(app.getHttpServer())
      .post('/api/v1/payments/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: id })
      .expect(422);
  });

  it('cancels a pending order on checkout.session.expired and releases stock', async () => {
    const { token } = await register('expired');
    const { id } = await createOrder(token, 1);
    const before = await inventory();

    const payload = sessionPayload(`evt_e2e_pay_exp_${suffix}`, 'checkout.session.expired', {
      id: 'cs_test_expired',
      amount_total: 100_00,
      currency: 'usd',
      client_reference_id: id,
      metadata: { orderId: id },
    });
    const { raw, signature } = signed(payload);
    await request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(raw)
      .expect(200);

    expect(await orderStatus(id, token)).toBe('CANCELLED');
    expect(await inventory()).toEqual({ stock: before.stock, reserved: before.reserved - 1 });
  });

  it('ignores a succeeded event whose amount does not match the frozen total', async () => {
    const { token } = await register('mismatch');
    const { id } = await createOrder(token, 1);
    const before = await inventory();

    const payload = sessionPayload(`evt_e2e_pay_mm_${suffix}`, 'checkout.session.completed', {
      id: 'cs_test_mismatch',
      amount_total: 1_00,
      currency: 'usd',
      client_reference_id: id,
      metadata: { orderId: id },
    });
    const { raw, signature } = signed(payload);
    await request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(raw)
      .expect(200);

    expect(await orderStatus(id, token)).toBe('PENDING_PAYMENT');
    expect(await inventory()).toEqual(before);
  });
});
