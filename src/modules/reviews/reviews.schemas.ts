import { z } from 'zod';

const uuidSchema = z.uuid({ error: 'must be a valid UUID' });

export const createReviewSchema = z.object({
  productId: uuidSchema,
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
});

export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const reviewListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

export const adminReviewListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED']).optional(),
  productId: uuidSchema.optional(),
});

export type AdminReviewListQuery = z.infer<typeof adminReviewListQuerySchema>;

export const moderateReviewSchema = z.object({
  status: z.enum(['PUBLISHED', 'REJECTED']),
});

export type ModerateReviewInput = z.infer<typeof moderateReviewSchema>;

export const reviewIdParamsSchema = z.object({ id: uuidSchema });

export type ReviewIdParams = z.infer<typeof reviewIdParamsSchema>;

export const reviewProductParamsSchema = z.object({ productId: uuidSchema });

export type ReviewProductParams = z.infer<typeof reviewProductParamsSchema>;
