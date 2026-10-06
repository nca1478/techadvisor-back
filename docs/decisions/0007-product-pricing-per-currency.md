# 0007 — Product pricing per currency: fixed price table with base fallback

Date: 2026-10-06
Status: accepted

## Context

AGENTS.md §1 requires multi-currency amounts stored as integers in the
minor unit with an ISO 4217 code, configured via `BASE_CURRENCY` /
`SUPPORTED_CURRENCIES`. Two candidate strategies:

1. **Fixed price per currency** (`product_prices` table: one row per
   product × currency).
2. **Base price + live FX conversion** (rates provider, rounding policy,
   caching, staleness handling).

## Decision

- **Option 1 (fixed price table).** `products` keeps the canonical base
  price (`price_amount` + `currency`, always `BASE_CURRENCY` at write
  time); `product_prices(product_id, currency, amount)` holds an explicit
  fixed price per extra currency (`UNIQUE(product_id, currency)`).
- Read path (`GET /catalog/products`, detail): the `currency` query param
  (default `BASE_CURRENCY`, must be in `SUPPORTED_CURRENCIES` else 400)
  resolves the display price as the override row when it exists, else the
  base price. The response always echoes the **actual** currency
  (`priceAmount` + `currency`), so the frontend never has to guess; when
  no override exists the base price is returned with the base currency.
- Price-range filters apply to the price **in the requested currency**:
  a product matches when it has a price in that currency (base or
  override) inside the range. Products with no price in the requested
  currency are excluded from range-filtered queries (documented, covered
  by tests).
- Price *sorting* uses the base `price_amount` (stable, paginable with
  `ORDER BY`). Displayed override prices are set consistently with base
  ordering, so sort order is preserved in practice. Exact
  per-currency `ORDER BY COALESCE(...)` is deferred until overrides
  exist for non-base currencies.
- No float anywhere: `amount` is `INTEGER` (minor units). Stripe
  conversion (`toStripeAmount`) arrives in P1.x with its own ADR; this
  table already gives it exact per-currency integers.
- No new dependencies (plain Prisma + PostgreSQL).

## Consequences

- Adding a currency price is an `INSERT`, never a rewrite: additive and
  auditable. No FX service, no rounding surprises, no cache invalidation.
- While overrides are absent (this phase), every response carries the
  base price; multi-currency display lights up as soon as rows are added
  (admin writes arrive in P1.7).
- If live conversion is ever wanted, it can be layered on top (a rate
  source feeding the same table periodically) without changing the API.
