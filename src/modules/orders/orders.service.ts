import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { pickLocalizedText, resolveLocale, resolvePrice } from '../catalog/catalog.service.js';
import { InsufficientStockException } from '../inventory/inventory.errors.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { OrderItemDto, OrderResponseDto } from './dto/orders.dto.js';
import { assertTransitionAllowed } from './order-status.js';
import {
  EmptyCartException,
  InactiveProductException,
  OrderNotFoundException,
} from './orders.errors.js';
import type { CreateOrderInput, OrderQuery, ShippingAddressInput } from './orders.schemas.js';

interface PricedLine {
  productId: string;
  qty: number;
  unitPriceAmount: number;
  name: string;
  slug: string;
}

/**
 * Checkout from the authenticated user cart (see ADR 0011).
 *
 * Money always comes from the database: unit prices are resolved per currency
 * (fixed override or base price, same rule as the cart) and frozen into
 * `OrderItem` rows. Stock reservation, order creation and cart clearing happen
 * in a single transaction, so a crash can never leave a half-created order or
 * a reservation without an order.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  requestedCurrency(currency: string | undefined): string {
    const requested = currency ?? this.config.BASE_CURRENCY;
    if (!this.config.SUPPORTED_CURRENCIES.includes(requested)) {
      throw new BadRequestException({
        message: `Unsupported currency "${requested}". Supported: ${this.config.SUPPORTED_CURRENCIES.join(', ')}`,
      });
    }
    return requested;
  }

  resolvedLocale(locale: string | undefined): string {
    return resolveLocale(locale, this.config.SUPPORTED_LOCALES, this.config.DEFAULT_LOCALE);
  }

  async createOrder(
    userId: string,
    input: CreateOrderInput,
    query: OrderQuery,
  ): Promise<OrderResponseDto> {
    const currency = this.requestedCurrency(query.currency);
    const locale = this.resolvedLocale(query.locale);

    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: {
              include: {
                prices: { where: { currency } },
                translations: { where: { locale } },
              },
            },
          },
        },
      },
    });
    const lines = cart?.items ?? [];
    if (cart === null || lines.length === 0) {
      throw new EmptyCartException();
    }

    const inactive = lines
      .filter((line) => line.product.status !== 'ACTIVE')
      .map((line) => line.productId);
    if (inactive.length > 0) {
      throw new InactiveProductException(inactive);
    }

    const availability = await this.inventory.getAvailabilityMap(
      lines.map((line) => line.productId),
    );
    const short = lines
      .filter((line) => line.qty > (availability.get(line.productId) ?? 0))
      .map((line) => line.productId);
    if (short.length > 0) {
      throw new InsufficientStockException(short);
    }

    const priced: PricedLine[] = lines.map((line) => {
      const price = resolvePrice(
        { amount: line.product.priceAmount, currency: line.product.currency },
        line.product.prices,
        currency,
      );
      return {
        productId: line.productId,
        qty: line.qty,
        unitPriceAmount: price.amount,
        name: pickLocalizedText(
          line.product.translations,
          locale,
          (row) => row.name,
          line.product.name,
        ),
        slug: line.product.slug,
      };
    });
    // The order currency is the resolved one: base prices are in BASE_CURRENCY
    // but overrides may price in the requested currency (see ADR 0007). Every
    // frozen line uses the same currency, so the total is a plain sum.
    const orderCurrency = currency;
    const totalAmount = priced.reduce((sum, line) => sum + line.unitPriceAmount * line.qty, 0);

    const created = await this.prisma.$transaction(async (tx) => {
      for (const line of [...priced].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
        const matched = await tx.$executeRaw`
          UPDATE "inventory"
          SET "reserved" = "reserved" + ${line.qty}, "updated_at" = NOW()
          WHERE "product_id" = ${line.productId}::uuid
            AND ("stock" - "reserved") >= ${line.qty}
        `;
        if (matched === 0) {
          // Lost a race with another checkout: nothing is persisted (rollback).
          throw new InsufficientStockException([line.productId]);
        }
      }
      const order = await tx.order.create({
        data: {
          userId,
          status: 'PENDING_PAYMENT',
          currency: orderCurrency,
          totalAmount,
          shipping: { ...input.shipping },
          items: {
            create: priced.map((line) => ({
              productId: line.productId,
              qty: line.qty,
              unitPriceAmount: line.unitPriceAmount,
            })),
          },
        },
        include: { items: true },
      });
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      return order;
    });

    return this.toResponse(created, priced, input.shipping);
  }

  async listOrders(userId: string, query: OrderQuery): Promise<OrderResponseDto[]> {
    const locale = this.resolvedLocale(query.locale);
    const rows = await this.prisma.order.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: { include: { translations: { where: { locale } } } },
          },
        },
      },
    });
    return rows.map((row) => this.toResponse(row, this.toPricedLines(row, locale), row.shipping));
  }

  async getOrderById(
    userId: string,
    orderId: string,
    query: OrderQuery,
  ): Promise<OrderResponseDto> {
    const row = await this.findOwnedOrder(userId, orderId, query.locale);
    return this.toResponse(
      row,
      this.toPricedLines(row, this.resolvedLocale(query.locale)),
      row.shipping,
    );
  }

  /**
   * Customer cancellation: only `PENDING_PAYMENT` orders (the only state that
   * holds a stock reservation for a customer order) release their reservation.
   */
  async cancelOrder(userId: string, orderId: string, query: OrderQuery): Promise<OrderResponseDto> {
    const locale = this.resolvedLocale(query.locale);
    const row = await this.findOwnedOrder(userId, orderId, locale);
    assertTransitionAllowed(row.status, 'CANCELLED');

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.order.update({
        where: { id: row.id },
        data: { status: 'CANCELLED' },
        include: { items: true },
      });
      for (const item of [...next.items].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
        await tx.$executeRaw`
          UPDATE "inventory"
          SET "reserved" = GREATEST(0, "reserved" - ${item.qty}), "updated_at" = NOW()
          WHERE "product_id" = ${item.productId}::uuid
        `;
      }
      return next;
    });
    return this.toResponse(updated, this.toPricedLines(row, locale), row.shipping);
  }

  /**
   * Guarded status change for payment/admin/expiry flows. Applies the stock
   * side effect of the target state atomically with the status update:
   * `PAID` commits the reservation (sale), `CANCELLED` releases it (from
   * `PENDING_PAYMENT`) or restocks it (from `PAID`/`PROCESSING`, already
   * committed). Throws `InvalidOrderTransitionException` (422) otherwise.
   */
  async transitionOrder(
    orderId: string,
    to: OrderStatus,
    txOverride?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (tx: Prisma.TransactionClient): Promise<void> => {
      const row = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (row === null) {
        throw new OrderNotFoundException();
      }
      assertTransitionAllowed(row.status, to);
      const from = row.status;
      await tx.order.update({ where: { id: row.id }, data: { status: to } });
      const ordered = [...row.items].sort((a, b) => (a.productId < b.productId ? -1 : 1));
      if (to === 'PAID') {
        for (const item of ordered) {
          const matched = await tx.$executeRaw`
            UPDATE "inventory"
            SET "stock" = "stock" - ${item.qty},
                "reserved" = "reserved" - ${item.qty},
                "updated_at" = NOW()
            WHERE "product_id" = ${item.productId}::uuid
              AND "reserved" >= ${item.qty}
              AND "stock" >= ${item.qty}
          `;
          if (matched === 0) {
            throw new InsufficientStockException([item.productId]);
          }
        }
      } else if (to === 'CANCELLED' && from === 'PENDING_PAYMENT') {
        for (const item of ordered) {
          await tx.$executeRaw`
            UPDATE "inventory"
            SET "reserved" = GREATEST(0, "reserved" - ${item.qty}), "updated_at" = NOW()
            WHERE "product_id" = ${item.productId}::uuid
          `;
        }
      } else if (to === 'CANCELLED') {
        // From PAID/PROCESSING: units were already committed, put them back.
        for (const item of ordered) {
          await tx.$executeRaw`
            UPDATE "inventory"
            SET "stock" = "stock" + ${item.qty}, "updated_at" = NOW()
            WHERE "product_id" = ${item.productId}::uuid
          `;
        }
      }
    };
    if (txOverride !== undefined) {
      await run(txOverride);
      return;
    }
    await this.prisma.$transaction(run);
  }

  /** Ids of `PENDING_PAYMENT` orders created before `cutoff` (expiry sweep). */
  async findExpiredPendingOrderIds(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  private async findOwnedOrder(userId: string, orderId: string, localeInput: string | undefined) {
    const locale = this.resolvedLocale(localeInput);
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: { include: { translations: { where: { locale } } } },
          },
        },
      },
    });
    if (row === null) {
      // Other users' orders 404 identically to unknown ids: ownership is
      // never revealed.
      throw new OrderNotFoundException();
    }
    return row;
  }

  private toPricedLines(
    row: {
      items: {
        productId: string;
        qty: number;
        unitPriceAmount: number;
        product: { name: string; slug: string; translations: { locale: string; name: string }[] };
      }[];
    },
    locale: string,
  ): PricedLine[] {
    return row.items.map((item) => ({
      productId: item.productId,
      qty: item.qty,
      unitPriceAmount: item.unitPriceAmount,
      name: pickLocalizedText(item.product.translations, locale, (t) => t.name, item.product.name),
      slug: item.product.slug,
    }));
  }

  private toResponse(
    order: { id: string; status: OrderStatus; currency: string; createdAt: Date; updatedAt: Date },
    priced: PricedLine[],
    shipping: unknown,
  ): OrderResponseDto {
    const items: OrderItemDto[] = priced.map((line) => ({
      productId: line.productId,
      name: line.name,
      slug: line.slug,
      qty: line.qty,
      unitPriceAmount: line.unitPriceAmount,
      lineTotalAmount: line.unitPriceAmount * line.qty,
    }));
    return {
      id: order.id,
      status: order.status,
      currency: order.currency,
      totalAmount: items.reduce((sum, item) => sum + item.lineTotalAmount, 0),
      itemCount: items.reduce((sum, item) => sum + item.qty, 0),
      shipping: shipping as OrderResponseDto['shipping'],
      items,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}

export type { ShippingAddressInput };
