import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque refresh-token helpers. The raw token is high-entropy random bytes
 * (base64url); only its SHA-256 hash is persisted (`token_hash`). SHA-256 —
 * not argon2 — is the right tool here: the token already has 256 bits of
 * entropy, so a fast deterministic hash is sufficient and keeps rotation
 * cheap. Raw tokens are never logged nor stored.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
