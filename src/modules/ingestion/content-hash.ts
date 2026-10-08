import { createHash } from 'node:crypto';

/**
 * Idempotency hash of the cleaned document text (see ADR 0019).
 *
 * The hash covers the *cleaned* text (not the raw bytes) so semantically
 * identical re-uploads (e.g. CRLF vs LF) converge instead of reprocessing.
 * SHA-256 hex, deterministic across processes and machines.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
