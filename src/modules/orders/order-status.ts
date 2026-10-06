import { UnprocessableEntityException } from '@nestjs/common';
import type { OrderStatus } from '../../generated/prisma/client.js';

/**
 * Explicit order state machine (see ADR 0011).
 *
 * ```text
 * PENDING_PAYMENT ──► PAID ──► PROCESSING ──► SHIPPED ──► DELIVERED
 *        │              │           │
 *        └──────────────┴───────────┴──► CANCELLED
 * ```
 *
 * `PAID` is entered only from the (future) Stripe webhook, never from the
 * frontend. Customers can only move `PENDING_PAYMENT → CANCELLED`; every
 * other transition is reserved for admin/payment flows and goes through
 * `OrdersService.transitionOrder`, which enforces this table.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Pure predicate: is `to` reachable from `from` in one step? */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Domain error: the requested status change is not in the transition table.
 * Surfaces as HTTP 422 with the uniform payload.
 */
export class InvalidOrderTransitionException extends UnprocessableEntityException {
  constructor(from: OrderStatus, to: OrderStatus) {
    super({
      message: `Cannot transition order from ${from} to ${to}`,
      details: { from, to, allowed: [...ORDER_TRANSITIONS[from]] },
    });
  }
}

/** Throws `InvalidOrderTransitionException` unless the move is allowed. */
export function assertTransitionAllowed(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidOrderTransitionException(from, to);
  }
}
