import { z } from 'zod';
import { getSpecsFields, type SpecFieldType } from './spec-fields.js';

/**
 * Image URLs are stored as https URLs only (no uploads in this phase).
 * Rejects `javascript:`, `data:` and any non-https scheme, and bounds the
 * length to the `VARCHAR(2048)` column. Used by admin writes (P1.7); the
 * read path re-exports it so the rule is testable in isolation.
 */
export const imageUrlSchema = z
  .string()
  .min(1, { error: 'image url is required' })
  .max(2048, { error: 'image url must be at most 2048 characters' })
  .refine((url) => url.startsWith('https://'), {
    error: 'image url must use the https scheme (javascript:, data: and http: are rejected)',
  })
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { error: 'image url must be a valid https URL' },
  );

const FIELD_TYPE_TO_ZOD: Record<SpecFieldType, z.ZodType> = {
  string: z.string().min(1).max(200),
  integer: z.number().int(),
  number: z.number(),
  boolean: z.boolean(),
  enum: z.string().min(1).max(100),
};

/**
 * Builds a strict-ish Zod schema for the `specs` JSONB of a category:
 * every declared key is optional, must match its declared type, and enum
 * keys are restricted to their options. Unknown keys are stripped so a
 * typo'd key can never be persisted silently (writes, P1.7).
 */
export function buildSpecsSchema(categorySlug: string): z.ZodType {
  const fields = getSpecsFields(categorySlug);
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let valueSchema = FIELD_TYPE_TO_ZOD[field.type];
    if (field.type === 'enum' && field.options) {
      valueSchema = z.enum(field.options as [string, ...string[]]);
    }
    shape[field.key] = valueSchema.optional();
  }
  return z.strictObject(shape).catchall(z.never());
}

/** Validates a `specs` object for a category slug. Unknown slugs accept `{}`. */
export function parseSpecs(categorySlug: string, specs: unknown): Record<string, unknown> {
  return buildSpecsSchema(categorySlug).parse(specs ?? {}) as Record<string, unknown>;
}
