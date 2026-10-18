import { z } from 'zod';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Body for `POST /compatibility/check`.
 *
 * Accepts either the legacy `productIds` set (each unit x1, kept for backward
 * compatibility) or the quantity-aware `items` list (one entry per distinct
 * product with its cart `qty`), or both combined. At least one of them is
 * required; distinct products are capped at 20, `qty` at 1..999 (same bound
 * as cart lines, see cart `MAX_QTY_PER_LINE`). Duplicates inside each list
 * are rejected so the engine sees each product once per entry; when the same
 * id appears in both lists, `items` qty wins. `locale` picks the
 * issue-message language and falls back server-side to the default locale.
 */
const productIdSchema = z
  .string()
  .trim()
  .regex(UUID_PATTERN, { error: 'each productId must be a UUID' });

const compatibilityItemSchema = z.object({
  productId: productIdSchema,
  qty: z
    .number({ error: 'qty is required and must be an integer' })
    .int({ error: 'qty must be an integer' })
    .min(1, { error: 'qty must be at least 1' })
    .max(999, { error: 'qty must be at most 999' }),
});

export const compatibilityCheckBodySchema = z
  .object({
    productIds: z
      .array(productIdSchema)
      .min(1, { error: 'productIds must contain at least one product id' })
      .max(20, { error: 'productIds must contain at most 20 product ids' })
      .refine((ids) => new Set(ids).size === ids.length, {
        error: 'productIds must not contain duplicates',
      })
      .optional(),
    items: z
      .array(compatibilityItemSchema)
      .min(1, { error: 'items must contain at least one item' })
      .max(20, { error: 'items must contain at most 20 items' })
      .refine((items) => new Set(items.map((item) => item.productId)).size === items.length, {
        error: 'items must not contain duplicates',
      })
      .optional(),
    locale: z
      .string()
      .trim()
      .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
      .optional(),
  })
  .refine((body) => (body.productIds?.length ?? 0) + (body.items?.length ?? 0) > 0, {
    error: 'either productIds or items is required',
  })
  .refine(
    (body) => {
      const distinct = new Set([
        ...(body.productIds ?? []),
        ...(body.items ?? []).map((item) => item.productId),
      ]);
      return distinct.size >= 1 && distinct.size <= 20;
    },
    { error: 'at most 20 distinct products per check' },
  );

export type CompatibilityCheckInput = z.output<typeof compatibilityCheckBodySchema>;
