import { z } from 'zod';

/**
 * Triage states of an `UnansweredQuery` row (see ADR 0040). Forward-only:
 * `NEW` → `IN_REVIEW` → `RESOLVED`. Reopening (`RESOLVED` → anything) is
 * rejected so the improvement loop cannot silently regress.
 */
export const unansweredStatusSchema = z.enum(['NEW', 'IN_REVIEW', 'RESOLVED']);

export type UnansweredStatusInput = z.output<typeof unansweredStatusSchema>;

/** Body for `PATCH /admin/advisor/unanswered/:id`. */
export const updateUnansweredStatusSchema = z.object({
  status: unansweredStatusSchema,
});

export type UpdateUnansweredStatusInput = z.output<typeof updateUnansweredStatusSchema>;

/** Query for `GET /admin/advisor/unanswered` (paginated, newest first). */
export const unansweredListQuerySchema = z.object({
  status: unansweredStatusSchema.optional(),
  reason: z.string().trim().min(1).max(60).optional(),
  productId: z.uuid({ error: 'productId must be a valid UUID' }).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type UnansweredListQuery = z.output<typeof unansweredListQuerySchema>;

/**
 * Query for `GET /admin/advisor/unanswered/groups`. Rows are grouped
 * in-memory by normalized question text (see `query-normalize.ts`); the
 * scan is bounded (`scanLimit`, max 2000) so one request can never walk
 * the whole table when the corpus gap log grows.
 */
export const unansweredGroupsQuerySchema = z.object({
  status: unansweredStatusSchema.optional(),
  reason: z.string().trim().min(1).max(60).optional(),
  scanLimit: z.coerce.number().int().min(1).max(2000).default(500),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type UnansweredGroupsQuery = z.output<typeof unansweredGroupsQuerySchema>;

/** Query for `GET /admin/advisor/feedback` (paginated, newest first). */
export const advisorFeedbackListQuerySchema = z.object({
  value: z.enum(['up', 'down']).optional(),
  abstained: z.coerce.boolean().optional(),
  productId: z.uuid({ error: 'productId must be a valid UUID' }).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AdvisorFeedbackListQuery = z.output<typeof advisorFeedbackListQuerySchema>;
