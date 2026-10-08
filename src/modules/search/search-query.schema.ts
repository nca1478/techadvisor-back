import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Query params for `GET /search`. Everything arrives as strings from
 * Express, so numbers are coerced; failures yield 400 via
 * `ZodValidationPipe`.
 *
 * `q` is capped at 200 characters — shorter than the 1000 accepted by
 * `RetrievalService`: search boxes send short natural-language queries, and
 * the cap bounds embedding cost and full-text work per request (ADR 0022).
 * Price bounds are minor-unit integers in the *requested* currency (ADR 0007).
 */
export const searchQuerySchema = z.object({
  q: z
    .string({ error: 'q is required' })
    .trim()
    .min(1, { error: 'q must not be empty' })
    .max(200, { error: 'q must be at most 200 characters long' }),
  category: z.string().trim().min(1).max(100).optional(),
  maxPrice: z.coerce.number().int().min(0).max(999_999_999).optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(CURRENCY_PATTERN, { error: 'currency must be a 3-letter ISO 4217 code' })
    .optional(),
  locale: z
    .string()
    .trim()
    .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
    .optional(),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

export type SearchQuery = z.output<typeof searchQuerySchema>;
