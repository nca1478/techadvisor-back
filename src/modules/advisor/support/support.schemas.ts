import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Body for `POST /advisor/support` (see ADR 0036).
 *
 * `question` is capped at 1000 characters — the same bound accepted by
 * `RetrievalService` — so one request can never cost more than one bounded
 * retrieval pass plus one LLM call. `orderId` optionally scopes the answer
 * to one of the caller's own orders (orders of other users 404 exactly like
 * unknown ids). `locale` selects the answer language and narrows full-text
 * configurations; it falls back to `DEFAULT_LOCALE` in the service when
 * missing or unsupported (never a 400).
 */
export const supportBodySchema = z.object({
  question: z
    .string({ error: 'question is required' })
    .trim()
    .min(1, { error: 'question must not be empty' })
    .max(1000, { error: 'question must be at most 1000 characters long' }),
  orderId: z.uuid({ error: 'orderId must be a valid UUID' }).optional(),
  locale: z
    .string()
    .trim()
    .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
    .optional(),
});

export type SupportInput = z.output<typeof supportBodySchema>;
