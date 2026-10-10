import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Body for `POST /advisor/compare` (see ADR 0035).
 *
 * `productIds` is a set of 2..3 unique product UUIDs — duplicates are
 * rejected so the table always compares distinct products. `useCase` is free
 * text (capped at 500 chars to bound prompt cost) telling the LLM which
 * differences matter; `locale` selects the summary language and falls back
 * to `DEFAULT_LOCALE` in the service when missing or unsupported (never a
 * 400).
 */
export const compareBodySchema = z.object({
  productIds: z
    .array(z.uuid({ error: 'each productId must be a valid UUID' }))
    .min(2, { error: 'productIds must contain 2 or 3 product ids' })
    .max(3, { error: 'productIds must contain 2 or 3 product ids' })
    .refine((ids) => new Set(ids).size === ids.length, {
      error: 'productIds must not contain duplicates',
    }),
  useCase: z
    .string({ error: 'useCase must be a string' })
    .trim()
    .min(1, { error: 'useCase must not be empty' })
    .max(500, { error: 'useCase must be at most 500 characters long' })
    .optional(),
  locale: z
    .string()
    .trim()
    .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
    .optional(),
});

export type CompareInput = z.output<typeof compareBodySchema>;
