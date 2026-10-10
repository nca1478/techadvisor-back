import { z } from 'zod';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Body for `POST /compatibility/check`.
 *
 * `productIds` is a set (1..20 unique UUIDs — duplicates are rejected so the
 * engine always sees each product once). `locale` picks the issue-message
 * language and falls back server-side to the default locale.
 */
export const compatibilityCheckBodySchema = z.object({
  productIds: z
    .array(z.string().trim().regex(UUID_PATTERN, { error: 'each productId must be a UUID' }))
    .min(1, { error: 'productIds must contain at least one product id' })
    .max(20, { error: 'productIds must contain at most 20 product ids' })
    .refine((ids) => new Set(ids).size === ids.length, {
      error: 'productIds must not contain duplicates',
    }),
  locale: z
    .string()
    .trim()
    .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
    .optional(),
});

export type CompatibilityCheckInput = z.output<typeof compatibilityCheckBodySchema>;
