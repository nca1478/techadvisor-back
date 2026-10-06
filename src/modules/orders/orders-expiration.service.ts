import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { InvalidOrderTransitionException } from './order-status.js';

/**
 * Time a `PENDING_PAYMENT` order may wait for payment before it is cancelled
 * and its stock reservation released (see ADR 0011).
 */
export const PENDING_ORDER_TTL_MS = 30 * 60 * 1000;

/** How often the sweeper looks for expired orders. */
export const EXPIRATION_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * In-process expiry sweeper (see ADR 0011 for why no BullMQ yet: the queue
 * infrastructure arrives in Fase 2; until then a lightweight interval covers
 * the single pending-payment TTL without new dependencies).
 *
 * The sweep is idempotent and safe under concurrency: each candidate moves
 * through the guarded `transitionOrder`, so an order cancelled or paid
 * concurrently is simply skipped. The interval is unref'd and cleared on
 * shutdown; it never runs under tests (`NODE_ENV=test`) so suites stay
 * deterministic and call `expirePendingOrders()` directly instead.
 */
@Injectable()
export class OrdersExpirationService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly orders: OrdersService) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test') {
      return;
    }
    const timer = setInterval(() => {
      this.expirePendingOrders().catch((error: unknown) => {
        console.log(
          JSON.stringify({
            level: 'error',
            msg: 'Order expiry sweep failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }, EXPIRATION_SWEEP_INTERVAL_MS);
    timer.unref();
    this.timer = timer;
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Cancels every `PENDING_PAYMENT` order older than the TTL, releasing its
   * reservation. Returns the number of orders expired.
   */
  async expirePendingOrders(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - PENDING_ORDER_TTL_MS);
    const ids = await this.orders.findExpiredPendingOrderIds(cutoff, 100);
    let expired = 0;
    for (const id of ids) {
      try {
        await this.orders.transitionOrder(id, 'CANCELLED');
        expired += 1;
      } catch (error) {
        // Paid/cancelled concurrently after the select: skip, do not fail the sweep.
        if (error instanceof InvalidOrderTransitionException) {
          continue;
        }
        throw error;
      }
    }
    return expired;
  }
}
