import { z } from 'zod';
import { SPECS_FIELDS_BY_CATEGORY } from '../../catalog/specs/spec-fields.js';

/**
 * Structured purchase constraints extracted from the conversation
 * (see ADR 0031). The LLM only EXTRACTS restrictions here — it never
 * recommends products. Amounts are integers in the currency's minor unit
 * (centavos, etc.) with an ISO 4217 code, never floats (see ADR 0007).
 */

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export const priceSchema = z.object({
  amount: z.number().int().nonnegative({ error: 'amount must be a non-negative integer' }),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(CURRENCY_PATTERN, { error: 'currency must be a 3-letter ISO 4217 code' }),
});

export type IntentPrice = z.output<typeof priceSchema>;

export const missingInfoSchema = z.enum(['category', 'budget', 'use', 'brand', 'specs']);

export type MissingInfo = z.output<typeof missingInfoSchema>;

/**
 * Raw LLM output schema. `mustHaveSpecs` stays permissive here on purpose:
 * unknown spec keys are DISCARDED in `IntentService` (never a validation
 * error), so a model hallucination degrades to fewer filters, not a retry.
 * Brand lists and use cases are trimmed, capped and deduplicated downstream.
 */
export const purchaseIntentSchema = z.object({
  categorySlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, { error: 'categorySlug must be kebab-case' })
    .max(64)
    .optional(),
  maxPrice: priceSchema.optional(),
  minPrice: priceSchema.optional(),
  useCases: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  mustHaveSpecs: z
    .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]))
    .default({}),
  brandsInclude: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  brandsExclude: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  missingInfo: z.array(missingInfoSchema).max(5).default([]),
});

export type PurchaseIntent = z.output<typeof purchaseIntentSchema>;

/** Every spec key declared in `SPECS_FIELDS_BY_CATEGORY` (single source of truth). */
export const KNOWN_SPEC_KEYS: ReadonlySet<string> = new Set(
  Object.values(SPECS_FIELDS_BY_CATEGORY).flatMap((fields) => fields.map((field) => field.key)),
);

/** Category slugs the extractor may output (seed + specs registry). */
export const KNOWN_CATEGORY_SLUGS: readonly string[] = Object.keys(SPECS_FIELDS_BY_CATEGORY);
