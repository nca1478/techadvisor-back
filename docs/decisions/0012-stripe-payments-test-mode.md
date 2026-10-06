# 0012 — Stripe payments in test mode behind a PaymentProvider

Date: 2026-10-06
Status: accepted

## Context

AGENTS.md §1/§4 require Stripe (test mode first) behind a `PaymentProvider`
interface, with the Stripe webhook as the only source of truth for marking an
order `PAID`. The business country is not fixed yet (global sale), so Stripe
availability for the operating country must be checked at
https://stripe.com/global before production — this check must not block
development. This ADR also records the SDK version choice, the
Checkout-vs-PaymentIntent choice, and the per-currency amount rule for
`toStripeAmount` (verified against the Stripe docs before implementing).

Tooling note: the Context7 MCP server **was** available in this session.
`/stripe/stripe-node` resolved but reported a stale version (`v19.1.0`),
while `npm view stripe version` returned `23.0.0` as the latest stable, so
`stripe@23.0.0` was installed with `--save-exact` and the version is
recorded here. No other dependencies were added.

## Decision

- **SDK: `stripe@23.0.0` (exact), test keys only.** The official SDK is
  imported **only** in `src/modules/payments/stripe-payment.provider.ts`
  (the single Stripe adapter); every other file depends on the
  `PaymentProvider` interface. Env validation rejects live keys: values
  starting with `sk_live_` fail boot with a legible error, so a live key
  can never be used by accident.
- **Checkout Session, not PaymentIntent (for now).** The backend creates a
  Stripe-hosted Checkout Session from the server-side order total and
  returns its URL; card data never touches our servers (no Elements, no
  card inputs, nothing to store). PaymentIntent + Elements stays a future
  option behind the same interface if a custom checkout UI is ever wanted.
- **Money never comes from the client.** `POST /payments/checkout` receives
  only `{ orderId }`; the amount, currency and line items are re-read from
  the database (frozen `OrderItem` prices). The Stripe idempotency key is
  derived from the order (`checkout-{orderId}`), so retried checkouts for
  the same order are safe.
- **Only the verified webhook marks `PAID`.** `POST /payments/webhook`
  uses the raw body (`rawBody: true` in `main.ts`) and
  `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)`.
  An invalid signature returns 400 and changes nothing. Success events
  (`checkout.session.completed`, plus `payment_intent.succeeded` for future
  flows) move the order `PENDING_PAYMENT → PAID` via
  `OrdersService.transitionOrder` (which commits the stock reservation).
  Failure/expiry events (`checkout.session.expired`,
  `checkout.session.async_payment_failed`, `payment_intent.payment_failed`)
  move it to `CANCELLED` (releasing the reservation). The frontend redirect
  (`success_url`) never changes order state — it is display only.
- **Webhook processing is idempotent.** Every accepted event id is stored
  in `processed_webhook_events(event_id UNIQUE)` inside the same
  transaction that applies the state change; an already-seen `event_id` is
  acknowledged without side effects.
- **`toStripeAmount(amountMinor, currency)` is the single conversion
  function** (`src/modules/payments/stripe-amount.ts`, unit-tested). It was
  designed from https://docs.stripe.com/currencies (checked 2026-10-06):
  Stripe expects amounts in the currency's minor unit, two-decimal unless
  listed as zero-decimal. Our DB already stores ISO 4217 minor units, so
  the function is the identity except for Stripe's documented quirks:
  - Zero-decimal (identity — amount IS the major unit): `BIF, CLP, DJF,
    GNF, JPY, KMF, KRW, MGA, PYG, RWF, VND, VUV, XAF, XOF, XPF`.
  - `ISK` / `UGX`: Stripe requires the legacy two-decimal representation
    (`amount = major × 100`, decimals always `00`), so our stored whole
    units are multiplied by 100 (and must divide evenly on the way back).
  - `HUF` / `TWD`: charged as normal two-decimal amounts (their
    zero-decimal treatment applies to payouts only) → identity.
  - Three-decimal `BHD, JOD, KWD, OMR, TND`: amounts are thousandths but
    Stripe requires the last digit to be `0` (partner compatibility), so
    the function rounds to the nearest multiple of 10 minor units.
  - Everything else (incl. `USD`, `EUR`): identity (cents).
  `fromStripeAmount` is the exact inverse for webhook amount verification.
- **Availability gate (non-blocking).** Before going live, verify the
  operating country at https://stripe.com/global; if Stripe is unavailable
  there, implement a second `PaymentProvider` (the interface makes this a
  new adapter + factory registration, no business-logic changes).
- **Local testing with Stripe CLI** (`stripe listen --forward-to
  localhost:3001/api/v1/payments/webhook`) is documented in `README.md`.

## Consequences

- Swapping payment providers (or adding PaymentIntent) touches one adapter
  file, not orders/payments logic.
- `payments` and `processed_webhook_events` tables are additive; no
  existing table is altered.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`
  are optional in local env (payments return 503 when unconfigured) but
  documented in `.env.example`; CI/e2e override the webhook secret with a
  test value and sign payloads with the SDK's
  `generateTestHeaderString`, so no real Stripe account is needed.
