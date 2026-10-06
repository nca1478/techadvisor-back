# 0009 — Inventory with atomic reservations

Date: 2026-10-06
Status: accepted

## Context

AGENTS.md §6 defines `Inventory(product_id, stock, reserved)` with the
available count as `stock - reserved`, reserved at order creation. The public
catalog must signal availability without leaking exact on-hand counts.

## Decision

- **Table `inventory`** (`product_id` PK + FK to `products(id)` ON DELETE
  CASCADE, `stock`/`reserved` INTEGER DEFAULT 0, `created_at`/`updated_at`).
  Additive migration only. Prisma cannot express CHECKs, so they are raw SQL
  in the migration: `stock >= 0`, `reserved >= 0`, `reserved <= stock`.
- **Single choke point:** `InventoryService` (`src/modules/inventory/`,
  `@Global()` like `PrismaModule`) owns every stock read and mutation:
  `getAvailable`, `getAvailabilityMap`, `reserve`, `release`, `commit`.
  No controller — there are no public write endpoints for inventory.
- **Atomicity via conditional UPDATE inside a transaction**, one row at a
  time (`reserved = reserved + qty WHERE (stock - reserved) >= qty`; matched
  rows `0` → `InsufficientStockException`, HTTP 409). Multi-line calls are
  all-or-nothing (the transaction rolls back on the first shortfall).
  Duplicate lines are aggregated and rows are touched in `productId` order to
  avoid deadlocks. No new dependencies (plain Prisma `$executeRaw`).
- **`release` is idempotent** (clamps at zero, missing rows are a no-op) so
  order-cancel/expire retries never fail. **`commit`** (sale finalized)
  decrements `stock` and `reserved` together and fails when the units were
  never reserved.
- **Public surface:** catalog list + detail expose only `inStock: boolean`
  and `availableQuantity` capped at `MAX_VISIBLE_AVAILABLE = 10`.
- **Lifecycle:** deleting a product cascades to its inventory row (same as
  images/prices/translations); products are retired via `ARCHIVED` status,
  not deletes.

## Consequences

- Concurrent reservations can never oversell: losers match zero rows and get
  a clear domain error (proven by `inventory.concurrency.spec.ts`: 20
  parallel `reserve(1)` over stock 5 → exactly 5 succeed).
- Cart/orders/admin (later tasks) must go through `InventoryService`; any
  direct Prisma write to `inventory` bypasses the atomicity contract and must
  be rejected in review.
