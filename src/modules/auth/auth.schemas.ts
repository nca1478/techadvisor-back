import { z } from 'zod';

/**
 * Input schemas for the auth endpoints. The backend validates every auth
 * payload with Zod (via `ZodValidationPipe`); login failures always map to a
 * generic 401 so they never reveal whether the email exists.
 */
export const registerSchema = z.object({
  email: z.email({ error: 'email must be a valid email address' }),
  password: z
    .string({ error: 'password is required' })
    .min(10, { error: 'password must be at least 10 characters long' })
    .max(128, { error: 'password must be at most 128 characters long' }),
  name: z
    .string({ error: 'name must be a string' })
    .trim()
    .min(1, { error: 'name must not be empty' })
    .max(100, { error: 'name must be at most 100 characters long' })
    .optional(),
});

export type RegisterInput = z.output<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email({ error: 'email must be a valid email address' }),
  password: z.string({ error: 'password is required' }).min(1, {
    error: 'password is required',
  }),
});

export type LoginInput = z.output<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string({ error: 'refreshToken is required' }).min(1, {
    error: 'refreshToken is required',
  }),
});

export type RefreshInput = z.output<typeof refreshSchema>;
