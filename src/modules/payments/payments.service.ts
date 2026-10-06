import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { OrderStatus } from '../../generated/prisma/client.js';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { OrderNotFoundException } from '../orders/orders.errors.js';
import type { CheckoutResponseDto } from './dto/payments.dto.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import type { CheckoutInput } from './payments.schemas.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhookHandleResult {
  duplicate: boolean;
  /** Order status applied by this delivery, or null when nothing changed. */
  transitionedTo: OrderStatus | null;
}

/**
 * Checkout + webhook application for paid orders (see ADR 0012).
 *
 * - Checkout re-reads prices from the database; the client only names the
 *   order. Every call for the same order reuses the provider idempotency key
 *   `checkout-{orderId}` and reuses the stored `Payment` row when it points
 *   at the same provider session.
 * - The webhook is the ONLY path that moves an order to `PAID` or cancels it
 *   for payment reasons. Signature failures (400) and unknown/duplicate
 *   events change nothing. A `succeeded` event whose amount or currency does
 *   not match the frozen order total is acknowledged but never applied.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private assertProviderConfigured(): void {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException('Payments are not configured');
    }
  }

  async createCheckout(userId: string, input: CheckoutInput): Promise<CheckoutResponseDto> {
    this.assertProviderConfigured();
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, userId },
      include: { items: true },
    });
    if (order === null) {
      // Other users' orders 404 exactly like unknown ids (same rule as
      // OrdersService: ownership is never revealed).
      throw new OrderNotFoundException();
    }
    if (order.status !== 'PENDING_PAYMENT') {
      throw new UnprocessableEntityException({
        message: `Order ${order.id} cannot be paid in status ${order.status}`,
        details: { status: order.status },
      });
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: order.items.map((item) => item.productId) } },
      select: { id: true, name: true },
    });
    const names = new Map(products.map((product) => [product.id, product.name]));
    const lines = order.items.map((item) => ({
      name: names.get(item.productId) ?? item.productId,
      unitAmountMinor: item.unitPriceAmount,
      quantity: item.qty,
    }));

    const origin = this.config.CORS_ORIGINS.split(',')[0]?.trim() || 'http://localhost:3000';
    const created = await this.provider.createPayment(
      {
        orderId: order.id,
        currency: order.currency,
        totalAmountMinor: order.totalAmount,
        lines,
        successUrl: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/checkout/cancel?orderId=${order.id}`,
      },
      `checkout-${order.id}`,
    );

    const existing = await this.prisma.payment.findFirst({
      where: { orderId: order.id, provider: this.provider.name, externalRef: created.sessionId },
    });
    if (existing === null) {
      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          provider: this.provider.name,
          status: 'PENDING',
          externalRef: created.sessionId,
        },
      });
    }
    return {
      provider: created.provider,
      sessionId: created.sessionId,
      checkoutUrl: created.checkoutUrl,
    };
  }

  async handleWebhook(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<WebhookHandleResult> {
    this.assertProviderConfigured();
    const event = this.provider.parseAndVerifyWebhook(rawBody, signature);
    if (event.provider !== this.provider.name) {
      throw new BadRequestException({ message: 'Unknown webhook provider' });
    }

    return this.prisma.$transaction(async (tx) => {
      try {
        await tx.processedWebhookEvent.create({
          data: { eventId: event.id, provider: event.provider },
        });
      } catch (error: unknown) {
        if (
          error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // Redelivery of an applied event: acknowledge, change nothing.
          return { duplicate: true, transitionedTo: null };
        }
        throw error;
      }

      if (event.outcome === 'ignored' || event.orderId === null) {
        return { duplicate: false, transitionedTo: null };
      }
      if (!UUID_PATTERN.test(event.orderId)) {
        // Forged or foreign metadata: recorded above, never applied.
        this.log('warn', 'Webhook references a non-UUID order id', { eventId: event.id });
        return { duplicate: false, transitionedTo: null };
      }
      const order = await tx.order.findUnique({ where: { id: event.orderId } });
      if (order === null) {
        this.log('warn', 'Webhook references an unknown order', { eventId: event.id });
        return { duplicate: false, transitionedTo: null };
      }

      if (event.outcome === 'succeeded') {
        if (
          event.amountMinor === null ||
          event.currency === null ||
          event.amountMinor !== order.totalAmount ||
          event.currency !== order.currency
        ) {
          // Amount/currency mismatch with the frozen total: never mark paid.
          this.log('warn', 'Webhook amount mismatch, order left untouched', {
            eventId: event.id,
          });
          return { duplicate: false, transitionedTo: null };
        }
        if (order.status !== 'PENDING_PAYMENT') {
          return { duplicate: false, transitionedTo: null };
        }
        await this.orders.transitionOrder(order.id, 'PAID', tx);
        await this.settlePayments(tx, order.id, event.externalRef, 'SUCCEEDED');
        return { duplicate: false, transitionedTo: 'PAID' };
      }

      // 'failed' | 'expired': release the reservation, but only while the
      // order still waits for payment (a later failure for an already-PAID
      // order — e.g. a second attempt — must never cancel the sale).
      if (order.status !== 'PENDING_PAYMENT') {
        return { duplicate: false, transitionedTo: null };
      }
      await this.orders.transitionOrder(order.id, 'CANCELLED', tx);
      await this.settlePayments(
        tx,
        order.id,
        event.externalRef,
        event.outcome === 'expired' ? 'CANCELED' : 'FAILED',
      );
      return { duplicate: false, transitionedTo: 'CANCELLED' };
    });
  }

  /**
   * Marks the order's pending payment attempts as settled. When no pending
   * row exists (e.g. the checkout row was never stored), a terminal row is
   * created so the webhook outcome stays auditable.
   */
  private async settlePayments(
    tx: PrismaNamespace.TransactionClient,
    orderId: string,
    externalRef: string | null,
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELED',
  ): Promise<void> {
    const matched = await tx.payment.updateMany({
      where: { orderId, provider: this.provider.name, status: 'PENDING' },
      data: {
        status,
        ...(externalRef === null ? {} : { externalRef }),
      },
    });
    if (matched.count === 0) {
      await tx.payment.create({
        data: { orderId, provider: this.provider.name, status, externalRef },
      });
    }
  }

  private log(level: 'warn', msg: string, extra: Record<string, string>): void {
    // Structured server-side log without personal or payment data.
    console.log(JSON.stringify({ level, msg, ...extra }));
  }
}
