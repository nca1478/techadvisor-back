import type { OrderStatus } from '../../generated/prisma/client.js';
import {
  ORDER_TRANSITIONS,
  InvalidOrderTransitionException,
  assertTransitionAllowed,
  canTransition,
} from './order-status.js';

const ALL: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
];

const EXPECTED: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

describe('order state machine', () => {
  it('exposes exactly the documented transition table', () => {
    expect(ORDER_TRANSITIONS).toEqual(EXPECTED);
  });

  it.each(ALL)('allows every documented transition out of %s', (from) => {
    for (const to of EXPECTED[from]) {
      expect(canTransition(from, to)).toBe(true);
      expect(() => {
        assertTransitionAllowed(from, to);
      }).not.toThrow();
    }
  });

  it.each(ALL)('rejects every undocumented transition out of %s', (from) => {
    const allowed = new Set<OrderStatus>(EXPECTED[from]);
    for (const to of ALL.filter((status) => !allowed.has(status))) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => {
        assertTransitionAllowed(from, to);
      }).toThrow(InvalidOrderTransitionException);
    }
  });

  it('self-transitions are never allowed', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('terminal states have no outgoing transitions', () => {
    expect(ORDER_TRANSITIONS['DELIVERED']).toEqual([]);
    expect(ORDER_TRANSITIONS['CANCELLED']).toEqual([]);
  });

  it('the domain error carries a 422 status with from/to/allowed details', () => {
    const error = new InvalidOrderTransitionException('SHIPPED', 'CANCELLED');
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({
      message: 'Cannot transition order from SHIPPED to CANCELLED',
      details: { from: 'SHIPPED', to: 'CANCELLED', allowed: ['DELIVERED'] },
    });
  });
});
