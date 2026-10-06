import { z } from 'zod';

/** Hard bound per cart line (see ADR 0010). */
export const MAX_QTY_PER_LINE: number = 999;

const productIdSchema = z.uuid({ error: 'productId must be a valid UUID' });

const qtySchema = z
  .number({ error: 'qty is required and must be an integer' })
  .int({ error: 'qty must be an integer' })
  .min(1, { error: 'qty must be at least 1' })
  .max(MAX_QTY_PER_LINE, { error: `qty must be at most ${String(MAX_QTY_PER_LINE)}` });

/**
 * Body schemas for cart writes. Prices/totals are never accepted from the
 * client: every response is computed server-side from the database.
 */
export const addCartItemSchema = z.object({
  productId: productIdSchema,
  qty: qtySchema,
});

export type AddCartItemInput = z.output<typeof addCartItemSchema>;

export const updateCartItemSchema = z.object({
  qty: qtySchema,
});

export type UpdateCartItemInput = z.output<typeof updateCartItemSchema>;

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Shared `locale`/`currency` query params (same semantics as the catalog). */
export const cartQuerySchema = z.object({
  locale: z
    .string()
    .trim()
    .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
    .optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(CURRENCY_PATTERN, { error: 'currency must be a 3-letter ISO 4217 code' })
    .optional(),
});

export type CartQuery = z.output<typeof cartQuerySchema>;
