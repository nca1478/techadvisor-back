import { z } from 'zod';

/**
 * Input schema for `PATCH /users/me`. Only `name` and `password` are
 * updatable; `email` is intentionally absent so it can never be changed
 * through this endpoint (unknown keys are stripped by Zod, never persisted).
 */
export const updateProfileSchema = z
  .object({
    name: z
      .string({ error: 'name must be a string' })
      .trim()
      .min(1, { error: 'name must not be empty' })
      .max(100, { error: 'name must be at most 100 characters long' })
      .optional(),
    password: z
      .string({ error: 'password is required' })
      .min(10, { error: 'password must be at least 10 characters long' })
      .max(128, { error: 'password must be at most 128 characters long' })
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.password !== undefined, {
    error: 'at least one of name or password is required',
  });

export type UpdateProfileInput = z.output<typeof updateProfileSchema>;
