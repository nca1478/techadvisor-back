import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

/** Name of the httpOnly cookie that identifies a guest cart. */
export const SID_COOKIE_NAME = 'sid';

/** Guest sessions live 30 days (rolling: re-issued on every cart write). */
export const SID_MAX_AGE_SEC: number = 30 * 24 * 60 * 60;

const SID_VALUE_PATTERN = /^[0-9a-f-]{1,64}\.[0-9a-f]{64}$/;

/**
 * Signs a fresh guest session id. Format `<uuid>.<hmac-sha256(uuid, secret)>`
 * so any tampering is detectable without server-side state. Pure (no I/O)
 * for unit tests; the secret is `JWT_SECRET` (see ADR 0010).
 */
export function signSessionId(sessionId: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(sessionId).digest('hex');
  return `${sessionId}.${mac}`;
}

/** Creates a new signed `sid` cookie value. */
export function newSignedSid(secret: string): { sessionId: string; signed: string } {
  const sessionId = randomUUID();
  return { sessionId, signed: signSessionId(sessionId, secret) };
}

/**
 * Verifies a presented `sid` cookie value and returns the session id, or
 * `null` when missing, malformed or tampered with (callers treat that as
 * "no guest session" and issue a fresh one).
 */
export function verifySignedSid(candidate: string | undefined, secret: string): string | null {
  if (typeof candidate !== 'string' || !SID_VALUE_PATTERN.test(candidate)) {
    return null;
  }
  const dot = candidate.lastIndexOf('.');
  const sessionId = candidate.slice(0, dot);
  const presented = candidate.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(sessionId).digest('hex');
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return sessionId;
}

/** Minimal cookie parser (no dependency): splits the `Cookie` header. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0 || value.length === 0) {
      continue;
    }
    // First occurrence wins; cookie values are not URL-decoded on purpose
    // (our `sid` value is hex + dot, decoding would only add attack surface).
    out[name] ??= value;
  }
  return out;
}

/** Reads and verifies the guest session id from the request cookies. */
export function readGuestSessionId(req: Request, secret: string): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return verifySignedSid(cookies[SID_COOKIE_NAME], secret);
}

/** Serializes the `sid` Set-Cookie value (httpOnly, host-path, Lax). */
export function serializeSidCookie(signed: string): string {
  return `${SID_COOKIE_NAME}=${signed}; HttpOnly; Path=/; Max-Age=${String(SID_MAX_AGE_SEC)}; SameSite=Lax`;
}

/** Serializes an expired `sid` cookie (cleared after a successful merge). */
export function serializeClearedSidCookie(): string {
  return `${SID_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

/** Issues (or refreshes) the guest `sid` cookie on the response. */
export function setGuestSessionCookie(res: Response, signed: string): void {
  res.setHeader('Set-Cookie', serializeSidCookie(signed));
}

/** Clears the guest `sid` cookie (after merge into the user cart). */
export function clearGuestSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', serializeClearedSidCookie());
}
