import { z } from 'zod';

/**
 * Password-reset OTP schemas. Same password policy as registration
 * (min 10 chars); OTP is exactly 6 digits, resetToken is opaque base64url.
 */
export const passwordResetRequestSchema = z.object({
  email: z.email({ error: 'email must be a valid email address' }),
});

export type PasswordResetRequestInput = z.output<typeof passwordResetRequestSchema>;

export const passwordResetVerifySchema = z.object({
  email: z.email({ error: 'email must be a valid email address' }),
  code: z
    .string({ error: 'code is required' })
    .regex(/^\d{6}$/, { error: 'code must be a 6-digit number' }),
});

export type PasswordResetVerifyInput = z.output<typeof passwordResetVerifySchema>;

const passwordRule = z
  .string({ error: 'password is required' })
  .min(10, { error: 'password must be at least 10 characters long' })
  .max(128, { error: 'password must be at most 128 characters long' });

export const passwordResetConfirmSchema = z
  .object({
    email: z.email({ error: 'email must be a valid email address' }),
    resetToken: z.string({ error: 'resetToken is required' }).min(1),
    password: passwordRule,
    confirmPassword: z.string({ error: 'confirmPassword is required' }).min(1),
  })
  .refine((value) => value.password === value.confirmPassword, {
    error: 'passwords do not match',
    path: ['confirmPassword'],
  });

export type PasswordResetConfirmInput = z.output<typeof passwordResetConfirmSchema>;
