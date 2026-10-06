# 0005 — Auth with argon2, short-lived JWT + rotating refresh tokens, roles and rate limiting

Date: 2026-10-06
Status: accepted

## Context

Phase 1 needs registration, login, refresh and role-based access control.
Versions were checked with the Context7 MCP (`/ranisalt/node-argon2`,
`/nestjs/jwt`, `/nestjs/throttler`) and `npm view` before installing.

## Decision

- **`argon2@0.45.1`** (argon2id defaults) for password hashing. Native
  binding verified working on this machine (`hash`/`verify` smoke test).
  Chosen over bcrypt because it is the PHC-recommended, memory-hard option
  and the task lists it first.
- **`@nestjs/jwt@12.0.2`** for access tokens (15 min default via
  `JWT_ACCESS_EXPIRES_IN_SEC=900`, HS256, payload `{ sub, role }`).
  Custom `JwtAuthGuard` (no `@nestjs/passport`) keeps the dependency
  surface minimal: the guard verifies `Authorization: Bearer <jwt>` with
  `JwtService.verifyAsync` and attaches `{ id, role }` to the request.
- **Opaque rotating refresh tokens**: 256-bit `crypto.randomBytes`,
  transported as base64url, stored **only as SHA-256 hash** in the
  `refresh_tokens` table (`token_hash` unique). Each use rotates:
  the presented token is revoked (`revoked_at`) and a new one is issued
  in the same transaction. Reuse of a revoked token revokes the whole
  token family chain (theft detection). Never logged, never returned
  except once at issue time.
- **`@nestjs/throttler@6.7.1`** scoped to `AuthController` only
  (`@UseGuards(ThrottlerGuard)` + `@Throttle(...)`), so only `/auth/*`
  is rate-limited per IP (defaults: 30 req / 60 s via
  `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_TTL_MS`). Peer deps allow
  `@nestjs/*@12`.
- **`RolesGuard` + `@Roles('ADMIN')`** with `Reflector`; always applied
  after `JwtAuthGuard`. Public registration hardcodes `role=CUSTOMER`.
- **Zod validation in the backend** via a small `ZodValidationPipe`
  (email valid, password >= 10 chars); failures use the uniform error
  payload. Login failures always return `401 "Invalid credentials"` so
  they do not reveal whether the email exists.
- **Minimal admin surface for the 403 criterion**: `GET /admin/ping`
  guarded with `@Roles('ADMIN')`. Full admin CRUD arrives later.

## Consequences

- New dependencies: `argon2`, `@nestjs/jwt`, `@nestjs/throttler`.
- New env vars (all with safe defaults): `JWT_ACCESS_EXPIRES_IN_SEC`,
  `JWT_REFRESH_EXPIRES_IN_SEC`, `AUTH_RATE_LIMIT_MAX`,
  `AUTH_RATE_LIMIT_TTL_MS`.
- New tables `users` and `refresh_tokens` (additive migration only).
