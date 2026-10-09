import type { Request, Response } from 'express';
import { getOptionalUser } from '../cart/optional-jwt-auth.guard.js';
import { newSignedSid, readGuestSessionId, setGuestSessionCookie } from '../cart/guest-session.js';
import type { ChatSessionOwner } from './chat-sessions.service.js';

/**
 * Resolves the chat-session owner for advisor routes (see ADR 0029).
 *
 * Authenticated requests resolve to the user; anonymous ones to the guest
 * session, issuing a fresh signed `sid` cookie when needed — the same scheme
 * as carts (ADR 0010). Shared by the sessions controller and product-QA so
 * both identify "the caller's own session" identically.
 */
export function resolveSessionOwner(req: Request, res: Response, secret: string): ChatSessionOwner {
  const user = getOptionalUser(req as unknown as Record<string, unknown>);
  if (user !== null) {
    return { kind: 'user', userId: user.id };
  }
  const sessionId = readGuestSessionId(req, secret);
  if (sessionId !== null) {
    return { kind: 'guest', anonSessionId: sessionId };
  }
  const fresh = newSignedSid(secret);
  setGuestSessionCookie(res, fresh.signed);
  return { kind: 'guest', anonSessionId: fresh.sessionId };
}
