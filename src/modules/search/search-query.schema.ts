import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const sortSchema = z.enum(['price_asc', 'price_desc', 'name_asc', 'name_desc', 'newest']);

export type SearchSort = z.output<typeof sortSchema>;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Query params for `GET /search`. Everything arrives as strings from
 * Express, so numbers are coerced; failures yield 400 via
 * `ZodValidationPipe`.
 *
 * `q` is optional and capped at 200 characters — shorter than the 1000
 * accepted by `RetrievalService`: search boxes send short natural-language
 * queries, and the cap bounds embedding cost and full-text work per request
 * (ADR 0022). An empty/missing `q` browses the catalog by the remaining
 * filters only (category/brand/sort/inStock/maxPrice, SQL-only, see ADR 0064):
 * every field is exclusive, any of them may be empty.
 * Price bounds are minor-unit integers in the *requested* currency (ADR 0007).
 * `sort` (same values as the catalog listing) replaces relevance order;
 * `inStock` (`1`/`true`) keeps only products with available stock.
 */
export const searchQuerySchema = z.object({
  q: z
    .string({ error: 'q must be a string' })
    .trim()
    .max(200, { error: 'q must be at most 200 characters long' })
    .optional()
    .default(''),
  category: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  sort: sortSchema.optional(),
  inStock: z.enum(['0', '1', 'true', 'false']).optional(),
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
