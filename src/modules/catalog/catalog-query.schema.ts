import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const sortSchema = z.enum(['price_asc', 'price_desc', 'name_asc', 'name_desc', 'newest']);

/**
 * Query params for `GET /catalog/products`. Everything arrives as strings
 * from Express, so numbers/enums are coerced; failures yield 400 via
 * `ZodValidationPipe`. Price bounds are minor-unit integers in the
 * *requested* currency (see ADR 0007).
 */
export const catalogQuerySchema = z
  .object({
    category: z.string().trim().min(1).max(100).optional(),
    brand: z.string().trim().min(1).max(100).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    minPrice: z.coerce.number().int().min(0).max(999_999_999).optional(),
    maxPrice: z.coerce.number().int().min(0).max(999_999_999).optional(),
    sort: sortSchema.default('newest'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
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
  })
  .refine((query) => query.maxPrice === undefined || query.maxPrice >= (query.minPrice ?? 0), {
    error: 'maxPrice must be greater than or equal to minPrice',
    path: ['maxPrice'],
  });

export type CatalogQuery = z.output<typeof catalogQuerySchema>;

/** Shared `locale`/`currency` params for detail endpoints. */
export const localeCurrencySchema = z.object({
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

export type LocaleCurrencyQuery = z.output<typeof localeCurrencySchema>;
