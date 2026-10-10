import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Body for the recommendation branch of `POST /advisor/sessions/:id/messages`
 * (see ADR 0032): present when the body carries `content` WITHOUT `role`.
 * The legacy shape (`role` + `content`, see `chat-sessions.schemas.ts`) keeps
 * its raw-append behavior untouched.
 */
export const recommendBodySchema = z.object({
  content: z
    .string({ error: 'content is required' })
    .trim()
    .min(1, { error: 'content must not be empty' }),
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

export type RecommendInput = z.output<typeof recommendBodySchema>;

/**
 * One LLM-proposed recommendation item. `productId` is validated AFTER the
 * call against the SQL closed set (unknown ids are dropped and the call is
 * retried once); `citations` are validated against the delivered evidence.
 */
export const recommendDraftItemSchema = z.object({
  productId: z.uuid({ error: 'productId must be a valid UUID' }),
  reason: z
    .string({ error: 'reason is required' })
    .trim()
    .min(1, { error: 'reason must not be empty' })
    .max(500, { error: 'reason must be at most 500 characters long' }),
  citations: z.array(z.number().int().min(1)).max(8).default([]),
});

export type RecommendDraftItem = z.output<typeof recommendDraftItemSchema>;

/**
 * Provider-neutral structured output of the recommendation draft (parsed via
 * `generateJson`: JSON + Zod + one correction retry, no tool-calling).
 * `text` carries `[n]` markers resolved by the backend; prices/stock figures
 * are forbidden by the prompt and hydrated from SQL instead.
 */
export const recommendDraftSchema = z.object({
  text: z
    .string({ error: 'text is required' })
    .trim()
    .min(1, { error: 'text must not be empty' })
    .max(4000, { error: 'text must be at most 4000 characters long' }),
  items: z.array(recommendDraftItemSchema).max(8).default([]),
});

export type RecommendDraft = z.output<typeof recommendDraftSchema>;
