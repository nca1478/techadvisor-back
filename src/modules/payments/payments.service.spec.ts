import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { OrderNotFoundException } from '../orders/orders.errors.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { VerifiedWebhookEvent } from './payment-provider.js';
import { PaymentsService } from './payments.service.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function knownRequestError(): unknown {
  return new PrismaNamespace.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

interface TxMocks {
  processedCreate: ReturnType<typeof vi.fn>;
  orderFindUnique: ReturnType<typeof vi.fn>;
  paymentUpdateMany: ReturnType<typeof vi.fn>;
  paymentCreate: ReturnType<typeof vi.fn>;
  tx: {
    processedWebhookEvent: { create: ReturnType<typeof vi.fn> };
    order: { findUnique: ReturnType<typeof vi.fn> };
    payment: { updateMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  };
}

function txMocks(): TxMocks {
  const processedCreate = vi.fn(() => Promise.resolve({ eventId: 'evt_1', provider: 'fake' }));
  const orderFindUnique = vi.fn();
  const paymentUpdateMany = vi.fn(() => Promise.resolve({ count: 1 }));
  const paymentCreate = vi.fn((args: unknown) => Promise.resolve(args));
  return {
    processedCreate,
    orderFindUnique,
    paymentUpdateMany,
    paymentCreate,
    tx: {
      processedWebhookEvent: { create: processedCreate },
      order: { findUnique: orderFindUnique },
      payment: { updateMany: paymentUpdateMany, create: paymentCreate },
    },
  };
}

function setup(tx: TxMocks['tx']): {
  service: PaymentsService;
  prisma: {
    order: { findFirst: ReturnType<typeof vi.fn> };
    product: { findMany: ReturnType<typeof vi.fn> };
    payment: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  };
  orders: { transitionOrder: ReturnType<typeof vi.fn> };
  provider: {
    name: string;
    isConfigured: ReturnType<typeof vi.fn>;
    createPayment: ReturnType<typeof vi.fn>;
    parseAndVerifyWebhook: ReturnType<typeof vi.fn>;
  };
} {
  const prisma = {
    order: { findFirst: vi.fn() },
    product: { findMany: vi.fn(() => Promise.resolve([])) },
    payment: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn((args: unknown) => Promise.resolve(args)),
    },
  };
  const orders = { transitionOrder: vi.fn(() => Promise.resolve()) };
  const provider = {
    name: 'fake',
    isConfigured: vi.fn(() => true),
    createPayment: vi.fn(() =>
      Promise.resolve({ provider: 'fake', sessionId: 'cs_fake', checkoutUrl: 'https://pay/fake' }),
    ),
    parseAndVerifyWebhook: vi.fn(),
  };
  const service = new PaymentsService(
    {
      ...prisma,
      $transaction: (callback: (txClient: unknown) => Promise<never>) => callback(tx),
    } as unknown as PrismaService,
    orders as unknown as OrdersService,
    provider,
    { CORS_ORIGINS: 'http://localhost:3000' } as AppConfig,
  );
  return { service, prisma, orders, provider };
}

const PENDING_ORDER = {
  id: ORDER_ID,
  userId: USER_ID,
  status: 'PENDING_PAYMENT',
  currency: 'USD',
  totalAmount: 200_00,
  items: [{ productId: 'p1', qty: 2, unitPriceAmount: 100_00 }],
};

function succeededEvent(overrides: Partial<VerifiedWebhookEvent> = {}): VerifiedWebhookEvent {
  return {
    id: 'evt_1',
    provider: 'fake',
    outcome: 'succeeded',
    orderId: ORDER_ID,
    externalRef: 'cs_fake',
    amountMinor: 200_00,
    currency: 'USD',
    ...overrides,
  };
}

describe('PaymentsService.createCheckout', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup(txMocks().tx);
  });

  it('returns 503 while the provider is unconfigured', async () => {
    ctx.provider.isConfigured.mockReturnValue(false);

    await expect(ctx.service.createCheckout(USER_ID, { orderId: ORDER_ID })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(ctx.provider.createPayment).not.toHaveBeenCalled();
  });

  it('404s orders owned by another user (never reveals ownership)', async () => {
    ctx.prisma.order.findFirst.mockResolvedValue(null);

    await expect(ctx.service.createCheckout(USER_ID, { orderId: ORDER_ID })).rejects.toBeInstanceOf(
      OrderNotFoundException,
    );
  });

  it('rejects non-pending orders (422)', async () => {
    ctx.prisma.order.findFirst.mockResolvedValue({ ...PENDING_ORDER, status: 'PAID' });

    await expect(ctx.service.createCheckout(USER_ID, { orderId: ORDER_ID })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(ctx.provider.createPayment).not.toHaveBeenCalled();
  });

  it('prices from the database with an order-derived idempotency key', async () => {
    ctx.prisma.order.findFirst.mockResolvedValue(PENDING_ORDER);
    ctx.prisma.product.findMany.mockResolvedValue([{ id: 'p1', name: 'Gadget' }]);

    const result = await ctx.service.createCheckout(USER_ID, { orderId: ORDER_ID });

    expect(result).toEqual({
      provider: 'fake',
      sessionId: 'cs_fake',
      checkoutUrl: 'https://pay/fake',
    });
    expect(ctx.provider.createPayment).toHaveBeenCalledOnce();
    const [req, key] = ctx.provider.createPayment.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(key).toBe(`checkout-${ORDER_ID}`);
    expect(req).toMatchObject({
      orderId: ORDER_ID,
      currency: 'USD',
      totalAmountMinor: 200_00,
      lines: [{ name: 'Gadget', unitAmountMinor: 100_00, quantity: 2 }],
    });
    expect(ctx.prisma.payment.create).toHaveBeenCalledOnce();
  });

  it('reuses the stored payment row for the same provider session', async () => {
    ctx.prisma.order.findFirst.mockResolvedValue(PENDING_ORDER);
    ctx.prisma.payment.findFirst.mockResolvedValue({ id: 'pay_1', externalRef: 'cs_fake' });

    await ctx.service.createCheckout(USER_ID, { orderId: ORDER_ID });

    expect(ctx.prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.handleWebhook', () => {
  let mocks: TxMocks;
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    mocks = txMocks();
    ctx = setup(mocks.tx);
  });

  function servedOrder(status: string): void {
    mocks.orderFindUnique.mockResolvedValue({
      id: ORDER_ID,
      status,
      currency: 'USD',
      totalAmount: 200_00,
    });
  }

  it('acks a redelivered event without side effects (P2002)', async () => {
    mocks.processedCreate.mockRejectedValue(knownRequestError());
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent());

    const result = await ctx.service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ duplicate: true, transitionedTo: null });
    expect(ctx.orders.transitionOrder).not.toHaveBeenCalled();
  });

  it('acks ignored events and events without an order', async () => {
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ outcome: 'ignored' }));

    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ orderId: null }));
    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    expect(ctx.orders.transitionOrder).not.toHaveBeenCalled();
  });

  it('acks unknown and malformed order ids without touching orders', async () => {
    servedOrder('PENDING_PAYMENT');
    mocks.orderFindUnique.mockResolvedValue(null);
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent());

    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    expect(ctx.orders.transitionOrder).not.toHaveBeenCalled();

    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ orderId: 'not-a-uuid' }));
    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    expect(ctx.orders.transitionOrder).not.toHaveBeenCalled();
  });

  it('never marks PAID on amount or currency mismatch', async () => {
    servedOrder('PENDING_PAYMENT');
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ amountMinor: 1_00 }));

    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });

    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ currency: 'EUR' }));
    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });

    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ amountMinor: null }));
    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    expect(ctx.orders.transitionOrder).not.toHaveBeenCalled();
  });

  it('marks a matching PENDING_PAYMENT order PAID and settles the payment', async () => {
    servedOrder('PENDING_PAYMENT');
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent());

    const result = await ctx.service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(result).toEqual({ duplicate: false, transitionedTo: 'PAID' });
    expect(ctx.orders.transitionOrder).toHaveBeenCalledWith(ORDER_ID, 'PAID', mocks.tx);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { orderId: ORDER_ID, provider: 'fake', status: 'PENDING' },
      data: { status: 'SUCCEEDED', externalRef: 'cs_fake' },
    });
  });

  it('does not re-transition an already resolved order (second event type)', async () => {
    servedOrder('PAID');
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ id: 'evt_2' }));

    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    expect(ctx.orders.transitionOrder).not.toHaveBeenCalled();
  });

  it('cancels a pending order on failure/expiry and never a paid one', async () => {
    servedOrder('PENDING_PAYMENT');
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent({ outcome: 'failed' }));

    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: 'CANCELLED',
    });
    expect(ctx.orders.transitionOrder).toHaveBeenCalledWith(ORDER_ID, 'CANCELLED', mocks.tx);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { orderId: ORDER_ID, provider: 'fake', status: 'PENDING' },
      data: { status: 'FAILED', externalRef: 'cs_fake' },
    });

    mocks.tx.order.findUnique = vi.fn(() => Promise.resolve({ id: ORDER_ID, status: 'PAID' }));
    servedOrder('PAID');
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(
      succeededEvent({ id: 'evt_3', outcome: 'expired' }),
    );
    await expect(ctx.service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toEqual({
      duplicate: false,
      transitionedTo: null,
    });
    expect(ctx.orders.transitionOrder).toHaveBeenCalledTimes(1);
  });

  it('creates a terminal payment row when no pending row exists', async () => {
    servedOrder('PENDING_PAYMENT');
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });
    ctx.provider.parseAndVerifyWebhook.mockReturnValue(succeededEvent());

    await ctx.service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(mocks.paymentCreate).toHaveBeenCalledWith({
      data: { orderId: ORDER_ID, provider: 'fake', status: 'SUCCEEDED', externalRef: 'cs_fake' },
    });
  });
});
