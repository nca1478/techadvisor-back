import { z } from 'zod';

/**
 * Body for POST /payments/checkout. Only the order id travels from the
 * client: amount, currency and lines are re-read from the database, so a
 * tampered total can never reach the provider (see ADR 0012).
 */
export const checkoutSchema = z.object({
  orderId: z.uuid({ error: 'orderId must be a valid UUID' }),
});

export type CheckoutInput = z.output<typeof checkoutSchema>;
