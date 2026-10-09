import { z } from 'zod';

/**
 * Params for `GET /advisor/sessions/:id` and `POST /advisor/sessions/:id/messages`.
 */
export const chatSessionParamsSchema = z.object({
  id: z.uuid({ error: 'id must be a valid UUID' }),
});

export type ChatSessionParams = z.output<typeof chatSessionParamsSchema>;

/**
 * Body for `POST /advisor/sessions/:id/messages` (see ADR 0029).
 *
 * `content` requires non-empty text here; the configurable
 * `ADVISOR_MESSAGE_MAX_LENGTH` cap is enforced in `ChatSessionsService` (so a
 * limit change needs no code change) and reported as a 400. `citations` and
 * `products` are opaque JSON arrays echoed back to the chat UI; the service
 * validates they are arrays but never interprets them.
 */
export const chatMessageBodySchema = z.object({
  role: z.enum(['USER', 'ASSISTANT'], { error: "role must be 'USER' or 'ASSISTANT'" }),
  content: z
    .string({ error: 'content is required' })
    .trim()
    .min(1, { error: 'content must not be empty' }),
  citations: z.array(z.unknown()).optional(),
  products: z.array(z.unknown()).optional(),
});

export type ChatMessageInput = z.output<typeof chatMessageBodySchema>;
