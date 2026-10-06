# 0006 — Catalog pagination: page/limit (offset) with total metadata

Date: 2026-10-06
Status: accepted

## Context

`GET /catalog/products` needs pagination. AGENTS.md §4 allows cursor or
`page/limit` but requires one documented choice. The storefront needs page
jumps ("page 1 of 12", direct links to page N), which cursor pagination
does not support well.

## Decision

- **Offset pagination with `page` (1-based, default 1) and `limit`
  (default 20, max 100).** Response envelope:
  `{ data, meta: { page, limit, total, totalPages, hasNext, hasPrev } }`.
- Invalid values (`page < 1`, `limit` out of `1..100`, non-numeric) are
  coerced by the Zod query schema and rejected with 400 + the uniform
  error payload.
- `total` comes from the same filtered `WHERE` clause as the page
  (Prisma `count` + `findMany` in one transaction), so filters and totals
  can never disagree.
- Cursor pagination is deferred: it only pays off for high-frequency
  real-time feeds. If catalog browsing ever shows instability under
  concurrent writes, revisit via a new ADR.

## Consequences

- Simple, linkable pages for the storefront and SEO (`?page=3`).
- Deep pages (`OFFSET` large) are slower, but the catalog is small
  (tens of products in this phase) and writes are admin-only, so rows
  are stable while a customer pages.
