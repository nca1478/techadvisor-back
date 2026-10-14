# 0051 — stripe-mock as a docker compose service for local payments

Date: 2026-10-14
Status: accepted

## Context

`docker-compose.yml` only ran postgres + redis, so local payment
development always needed the real Stripe test API (network + test keys)
or the Stripe CLI. The request is to run Stripe as a compose service.
Stripe has no self-hosted API; the official local double is
**stripe-mock** (`stripe/stripe-mock:latest`, HTTP `12111` + HTTPS/HTTP2
`12112`), which validates request URLs/params and returns fixtures
without network access.

Tooling note: the Context7 MCP server **was** available in this session.
`/stripe/stripe-node` (v23.0.0, matching our pinned `stripe@23.0.0`)
documents pointing the SDK at a non-Stripe host via the constructor
options `{ host, port, protocol }` (per-request host was removed in v22);
`/stripe/stripe-mock` documents `docker run -p 12111-12112:12111-12112
stripe/stripe-mock:latest`. No npm dependency was added or updated.

## Decision

- **New `stripe-mock` service in `backend/docker-compose.yml`:**
  `image: stripe/stripe-mock:latest`, ports `12111:12111` + `12112:12112`,
  with a `wget --spider http://localhost:12111/` healthcheck. No volumes,
  no env needed — the mock is stateless.
- **New optional env `STRIPE_BASE_URL`** (validated as `http(s)://` URL,
  empty = unset): when set (e.g. `http://localhost:12111`), the
  `StripePaymentProvider` builds the SDK as `new Stripe(key, { host, port,
  protocol })` parsed from that URL. Unset keeps the default behaviour
  (real Stripe test API). Webhook signature verification is unchanged and
  still uses `STRIPE_WEBHOOK_SECRET` + the raw body.
- **Scope limits (unchanged from ADR 0012):** test keys only
  (`sk_test_*` enforced at boot); stripe-mock fixtures have fixed ids/URLs
  and never fire real webhooks, so end-to-end webhook flows still use
  `stripe trigger` / `stripe listen --forward-to` against test keys. The
  mock covers checkout-session creation offline; it is not a full Stripe
  emulator.

## Consequences

- `docker compose up -d` now starts postgres + redis + stripe-mock; with
  `STRIPE_BASE_URL=http://localhost:12111` in `.env`,
  `POST /api/v1/payments/checkout` works fully offline.
- `GET /api/v1/config/public` and the payments 503-when-unconfigured
  behaviour are unchanged; `STRIPE_BASE_URL` alone never enables payments
  (keys are still required).
- The SDK import stays confined to `stripe-payment.provider.ts`
  (AGENTS.md §5.11); swapping/removing the mock touches only compose +
  one env var, no business logic.
