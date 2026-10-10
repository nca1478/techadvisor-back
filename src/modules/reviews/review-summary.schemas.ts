import { z } from 'zod';

/**
 * Structured summary enforced in code via `generateJson` (see ADR 0037).
 * Bounds are deliberately tight so a malicious review (prompt injection)
 * can never stretch the shape: short paraphrases only, never long quotes.
 * `basedOnCount` is validated but always OVERWRITTEN server-side with the
 * real published-review count — the model must never decide it.
 */
export const reviewSummaryJsonSchema = z.object({
  pros: z.array(z.string().trim().min(1).max(140)).max(8),
  cons: z.array(z.string().trim().min(1).max(140)).max(8),
  basedOnCount: z.number().int().min(0),
});

export type ReviewSummaryJson = z.infer<typeof reviewSummaryJsonSchema>;
