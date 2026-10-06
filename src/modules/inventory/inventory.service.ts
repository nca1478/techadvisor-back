import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  InsufficientStockException,
  InvalidQuantityException,
  type StockItem,
} from './inventory.errors.js';

/** Maximum units the public API ever reveals per product (no exact stock leak). */
export const MAX_VISIBLE_AVAILABLE = 10;

export interface Availability {
  inStock: boolean;
  availableQuantity: number;
}

/**
 * Maps an exact available count to the public availability shape.
 * Pure helper (no database access) so it is unit-testable in isolation.
 */
export function toAvailability(available: number): Availability {
  const safe = Math.max(0, available);
  return { inStock: safe > 0, availableQuantity: Math.min(safe, MAX_VISIBLE_AVAILABLE) };
}

/**
 * Single choke point for every stock mutation in the system (carts, orders,
 * admin adjustments all go through here; there are no public write endpoints
 * for inventory).
 *
 * Concurrency strategy: every mutation is a single conditional `UPDATE`
 * executed inside a transaction. The row lock plus the `WHERE available >= qty`
 * predicate make each reservation atomic at the row level, so N concurrent
 * reservations over a limited stock can never oversell — losers simply match
 * zero rows and get an `InsufficientStockException`. DB CHECKs
 * (`stock >= 0`, `reserved >= 0`, `reserved <= stock`) are the backstop.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Units available for sale (`stock - reserved`); 0 when no row exists. */
  async getAvailable(productId: string): Promise<number> {
    const row = await this.prisma.inventory.findUnique({ where: { productId } });
    if (!row) {
      return 0;
    }
    return Math.max(0, row.stock - row.reserved);
  }

  /** Available units for many products in one round trip (catalog lists). */
  async getAvailabilityMap(productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.inventory.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, stock: true, reserved: true },
    });
    return new Map(rows.map((row) => [row.productId, Math.max(0, row.stock - row.reserved)]));
  }

  /**
   * Holds `qty` units per item for a future order. Atomic: either every line
   * is reserved or the whole call fails and nothing is held.
   */
  async reserve(items: StockItem[]): Promise<void> {
    const lines = normalizeItems(items);
    await this.prisma.$transaction(async (tx) => {
      for (const line of lines) {
        const matched = await tx.$executeRaw`
          UPDATE "inventory"
          SET "reserved" = "reserved" + ${line.qty}, "updated_at" = NOW()
          WHERE "product_id" = ${line.productId}::uuid
            AND ("stock" - "reserved") >= ${line.qty}
        `;
        if (matched === 0) {
          throw new InsufficientStockException([line.productId]);
        }
      }
    });
  }

  /**
   * Releases a previous reservation (order cancelled / expired / cart cleared).
   * Idempotent: releasing more than held clamps at zero and missing rows are
   * a no-op, so retries never fail.
   */
  async release(items: StockItem[]): Promise<void> {
    const lines = normalizeItems(items);
    await this.prisma.$transaction(async (tx) => {
      for (const line of lines) {
        await tx.$executeRaw`
          UPDATE "inventory"
          SET "reserved" = GREATEST(0, "reserved" - ${line.qty}), "updated_at" = NOW()
          WHERE "product_id" = ${line.productId}::uuid
        `;
      }
    });
  }

  /**
   * Finalizes a sale: reserved units leave the building. Both `stock` and
   * `reserved` decrease together, so `reserved <= stock` always holds.
   * Fails with `InsufficientStockException` when the units were never reserved.
   */
  async commit(items: StockItem[]): Promise<void> {
    const lines = normalizeItems(items);
    await this.prisma.$transaction(async (tx) => {
      for (const line of lines) {
        const matched = await tx.$executeRaw`
          UPDATE "inventory"
          SET "stock" = "stock" - ${line.qty},
              "reserved" = "reserved" - ${line.qty},
              "updated_at" = NOW()
          WHERE "product_id" = ${line.productId}::uuid
            AND "reserved" >= ${line.qty}
            AND "stock" >= ${line.qty}
        `;
        if (matched === 0) {
          throw new InsufficientStockException([line.productId]);
        }
      }
    });
  }
}

/**
 * Validates, aggregates duplicate lines and sorts by productId (stable lock
 * order, avoids deadlocks when concurrent transactions touch the same rows).
 */
function normalizeItems(items: StockItem[]): StockItem[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (typeof item.productId !== 'string' || item.productId.length === 0) {
      throw new InvalidQuantityException('Each item requires a productId.');
    }
    if (!Number.isInteger(item.qty) || item.qty <= 0) {
      throw new InvalidQuantityException(
        `Quantity for product "${item.productId}" must be a positive integer.`,
      );
    }
    totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.qty);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, qty]) => ({ productId, qty }));
}
