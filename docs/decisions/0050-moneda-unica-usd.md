# 0050 — Operación temporal en moneda única (USD)

Date: 2026-10-14
Status: accepted

## Context

The shop is configured for `BASE_CURRENCY=USD` with
`SUPPORTED_CURRENCIES=USD,EUR`, but the business will operate in USD only
for now; EUR is enabled later. The header currency dropdown must not offer
a currency the operation does not use yet.

## Decision

- Ship `.env.example` with `SUPPORTED_CURRENCIES=USD` (base stays `USD`).
- No code changes: re-enabling EUR is a config-only change
  (`SUPPORTED_CURRENCIES=USD,EUR`), which `GET /config/public` propagates
  to the frontend. The multi-currency price table (ADR 0007) is untouched.
- Existing deployments must update their local `.env` the same way and
  restart the API.

## Consequences

- Requests with `?currency=EUR` now fail with 400 (unsupported currency)
  until EUR is re-enabled; the frontend hides the selector when a single
  currency is advertised, so users cannot reach that state from the UI.
- No migration, no endpoint changes.
