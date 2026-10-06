import { z } from 'zod';

const ISO_COUNTRY_PATTERN = /^[A-Z]{2}$/;

/**
 * International shipping address (see ADR 0011).
 *
 * Only `country` has a strict format (ISO 3166-1 alpha-2, uppercased). The
 * remaining fields stay flexible on purpose: postal-code formats, required
 * regions and address-line conventions vary per country and are treated as
 * configuration for later phases — nothing country-specific is hardcoded
 * here. `region` (state/province) and `postalCode` are optional because not
 * every country uses them.
 */
export const shippingAddressSchema = z.object({
  fullName: z
    .string({ error: 'shipping.fullName is required' })
    .trim()
    .min(1, { error: 'shipping.fullName must not be empty' })
    .max(120, { error: 'shipping.fullName must be at most 120 characters long' }),
  line1: z
    .string({ error: 'shipping.line1 is required' })
    .trim()
    .min(1, { error: 'shipping.line1 must not be empty' })
    .max(200, { error: 'shipping.line1 must be at most 200 characters long' }),
  line2: z
    .string({ error: 'shipping.line2 must be a string' })
    .trim()
    .max(200, { error: 'shipping.line2 must be at most 200 characters long' })
    .optional(),
  city: z
    .string({ error: 'shipping.city is required' })
    .trim()
    .min(1, { error: 'shipping.city must not be empty' })
    .max(120, { error: 'shipping.city must be at most 120 characters long' }),
  region: z
    .string({ error: 'shipping.region must be a string' })
    .trim()
    .max(120, { error: 'shipping.region must be at most 120 characters long' })
    .optional(),
  postalCode: z
    .string({ error: 'shipping.postalCode must be a string' })
    .trim()
    .min(1, { error: 'shipping.postalCode must not be empty' })
    .max(20, { error: 'shipping.postalCode must be at most 20 characters long' })
    .optional(),
  country: z
    .string({ error: 'shipping.country is required (ISO 3166-1 alpha-2, e.g. ES)' })
    .trim()
    .toUpperCase()
    .regex(ISO_COUNTRY_PATTERN, {
      error: 'shipping.country must be a 2-letter ISO 3166-1 code (e.g. ES)',
    }),
  phone: z
    .string({ error: 'shipping.phone must be a string' })
    .trim()
    .min(1, { error: 'shipping.phone must not be empty' })
    .max(30, { error: 'shipping.phone must be at most 30 characters long' })
    .optional(),
});

export type ShippingAddressInput = z.output<typeof shippingAddressSchema>;

export const createOrderSchema = z.object({
  shipping: shippingAddressSchema,
});

export type CreateOrderInput = z.output<typeof createOrderSchema>;

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Shared `locale`/`currency` query params (same semantics as cart/catalog). */
export const orderQuerySchema = z.object({
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

export type OrderQuery = z.output<typeof orderQuerySchema>;

export const orderIdParamsSchema = z.object({
  id: z.uuid({ error: 'id must be a valid UUID' }),
});

export type OrderIdParams = z.output<typeof orderIdParamsSchema>;
