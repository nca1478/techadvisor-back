import { z } from 'zod';

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Body for `POST /advisor/product-qa` (see ADR 0025).
 *
 * `question` is capped at 1000 characters — the same bound accepted by
 * `RetrievalService` — so one request can never cost more than one bounded
 * retrieval pass plus one LLM call. `locale` selects the answer language and
 * narrows full-text configurations; it falls back to `DEFAULT_LOCALE` in
 * the service when missing or unsupported (never a 400).
 */
export const productQaBodySchema = z.object({
  productId: z.uuid({ error: 'productId must be a valid UUID' }),
  question: z
    .string({ error: 'question is required' })
    .trim()
    .min(1, { error: 'question must not be empty' })
    .max(1000, { error: 'question must be at most 1000 characters long' }),
  locale: z
    .string()
    .trim()
    .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' })
    .optional(),
  /**
   * Optional chat session to record this turn in (see ADR 0030). When set,
   * the session must be owned by the caller (user or guest `sid`); otherwise
   * the request 404s exactly like an unknown session, before any retrieval
   * or LLM call.
   */
  sessionId: z.uuid({ error: 'sessionId must be a valid UUID' }).optional(),
});

export type ProductQaInput = z.output<typeof productQaBodySchema>;

/**
 * Body for `POST /advisor/feedback` (Fase 3, P3.3 stub).
 *
 * Same bounds as the widget that sends it: `question` capped at 1000 chars
 * like product-QA, `answer` capped at 20000 chars to bound row size (LLM
 * answers are concise by prompt contract), `productId` optional so future
 * surfaces without a product context stay forward-compatible.
 */
export const feedbackBodySchema = z.object({
  productId: z.uuid({ error: 'productId must be a valid UUID' }).optional(),
  question: z
    .string({ error: 'question is required' })
    .trim()
    .min(1, { error: 'question must not be empty' })
    .max(1000, { error: 'question must be at most 1000 characters long' }),
  answer: z
    .string({ error: 'answer is required' })
    .trim()
    .min(1, { error: 'answer must not be empty' })
    .max(20000, { error: 'answer must be at most 20000 characters long' }),
  abstained: z.boolean({ error: 'abstained is required' }),
  value: z.enum(['up', 'down'], { error: "value must be 'up' or 'down'" }),
  /**
   * Chat session the voted answer belongs to (when the vote comes from a
   * sessioned surface like the product widget). Plain id, never validated
   * for ownership here: votes are unauthenticated by design and the id
   * only powers the admin-side minimized conversation link (ADR 0040).
   */
  sessionId: z.uuid({ error: 'sessionId must be a valid UUID' }).optional(),
});

export type FeedbackInput = z.output<typeof feedbackBodySchema>;
