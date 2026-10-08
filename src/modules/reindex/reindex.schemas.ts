import { z } from 'zod';

/**
 * Route params for job-scoped reindex endpoints. Reindex job ids are UUIDs
 * (same shape as the shared admin `uuidParams`, declared locally so the
 * reindex module never imports from the admin module).
 */
export const reindexJobParamsSchema = z.object({
  id: z.uuid({ error: 'id must be a valid UUID' }),
});

export type ReindexJobParams = z.output<typeof reindexJobParamsSchema>;
