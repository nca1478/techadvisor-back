# 0013 — Admin management API (`/admin/*`)

Date: 2026-10-06
Status: accepted

## Context

Fase 1 needs a back-office for catalog, inventory and order fulfillment
(AGENTS.md §1, "Admin"). Constraints from the task and AGENTS.md §5:

- Every route is admin-only (`JwtAuthGuard` + `@Roles('ADMIN')`).
- Archiving a product is logical (status change), never a physical delete,
  so historical orders keep working.
- Every stock change leaves an audit row in `InventoryMovement` (additive
  migration, no changes to existing tables).
- Order status changes must respect the state machine in
  `order-status.ts`; only the Stripe webhook marks orders as paid
  (restriction 7b).
- Product writes must honor ADR 0007 (fixed price per currency, base price
  in `BASE_CURRENCY`) and ADR 0008 (base columns hold `DEFAULT_LOCALE`,
  translation tables hold other supported locales), and `specs` must be
  validated against the Zod schema of the product category.

## Decision

- **Module `AdminService` + `AdminController`** under `/admin/*`, guards at
  controller level (`@UseGuards(JwtAuthGuard, RolesGuard)` +
  `@Roles('ADMIN')`). The existing `GET /admin/ping` probe is kept.
  `AdminModule` imports `OrdersModule` to reuse the guarded
  `OrdersService.transitionOrder` — the machine stays enforced in one
  place.
- **Products:** `GET` (list with `status`/`category`/`brand`/`q` filters,
  no `ACTIVE`-only scoping — unlike the public catalog), `POST`, `GET
  by id`, `PATCH`, `PATCH /:id/status`. No `DELETE` endpoint exists on
  purpose. `prices`/`translations` on `PATCH` (when present) **replace**
  the whole set, same replace semantics as images.
- **Images:** `PUT /admin/products/:id/images` receives the complete
  ordered list (`[{ url, alt? }]`, max 10, https URLs only via the shared
  `imageUrlSchema`) and replaces the set transactionally with positions
  reassigned `0..n-1`. Empty array removes all images. Add, remove,
  reorder and URL change are a single call.
- **Money/i18n on writes:** base `priceAmount`/`currency` must use
  `BASE_CURRENCY` (else 400); `prices` overrides must be supported,
  non-base, unique currencies (else 400). Translations must be supported,
  non-default, unique locales (else 400). `specs` is validated with
  `parseSpecs(categorySlug, …)`; a category change re-validates the
  stored specs so they can never go stale. Unique violations
  (`sku`/`slug`) surface as 409 via `P2002` mapping.
- **Categories/brands:** basic CRUD. `DELETE` is guarded: 409 while
  subcategories/products (category) or products (brand) reference the row.
  Category parent changes walk the ancestor chain to reject cycles.
- **Inventory:** `GET` (exact levels, admin-only), `PATCH` with
  `{ delta, reason }`. `delta: 0` is rejected (400); results below zero
  are rejected (400); results below `reserved` are rejected (409). The
  stock update and the `InventoryMovement` row
  (`delta`, `reason`, `stockAfter`) are written in one transaction.
  `POST /products` with `initialStock > 0` also appends an initial
  movement (`'Initial stock on product creation'`), so the audit trail
  has no gaps. `reserved` is never touched here (reservations belong to
  carts/orders).
- **Orders:** `GET` (list with `status`/`userId`/`from`/`to` filters,
  newest first, paginated), `GET by id`, `PATCH /:id/status` delegating
  to `transitionOrder` (unknown id → 404, illegal step → 422).
  Transitions **into `PAID` are rejected with 422**: only the Stripe
  webhook (verified signature) enters `PAID`. The
  `PAID→PROCESSING→SHIPPED→DELIVERED` chain (plus `CANCELLED` exits per
  the machine) is the admin fulfillment path.
- **Pagination** for admin lists reuses the `page`/`limit` convention
  (ADR 0006), newest-first for orders, no cursor (back-office volumes).
- No new dependencies (Prisma + Zod only).

## Consequences

- The public catalog is unaffected: it keeps reading `ACTIVE` products
  only, so archival hides a product publicly while admin and order
  history still resolve it.
- `InventoryMovement` rows are append-only; product cleanup in tests
  relies on the `ON DELETE CASCADE` FK (audit of deleted fixtures goes
  with them — acceptable outside production).
- Admin order writes never bypass payment: fulfillment starts at `PAID`,
  which test suites simulate with a direct DB update (documented in the
  e2e spec) since only the webhook produces it.
- Deep category-cycle protection is a bounded ancestor walk — enough for
  an admin UI; concurrent conflicting parent updates could still race
  (accepted: admin-only, low concurrency).
