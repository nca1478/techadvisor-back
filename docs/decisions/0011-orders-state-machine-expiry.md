# 0011 — Orders from cart with stock reservation and state machine

Date: 2026-10-06
Status: accepted

## Context

AGENTS.md §6 defines `Order(id, user_id, status, currency, total_amount,
shipping JSONB, …)` / `OrderItem(order_id, product_id, qty,
unit_price_amount)` with statuses `PENDING_PAYMENT, PAID, PROCESSING,
SHIPPED, DELIVERED, CANCELLED`. No new dependencies were installed for this
task (no BullMQ, no scheduler library: expiry is a plain `setInterval` in
`OrdersExpirationService`). Context7 MCP is not active in this environment,
and since no package was installed no version lookup was needed
(`npm view` alternative not required either).

## Decision

- **Tables `orders` / `order_items`** (additive migration `add_orders`):
  `orders` holds `user_id` (FK cascade), `status` (`OrderStatus` enum,
  default `PENDING_PAYMENT`), `currency` (ISO 4217), `total_amount` (minor
  units, frozen), `shipping` (JSONB snapshot of the validated address) plus
  `created_at`/`updated_at` and indexes on `(user_id)`, `(status)`,
  `(createdAt)` (the expiry sweep filters on the latter two).
  `order_items` holds `qty` + frozen `unit_price_amount` with
  `@@unique([orderId, productId])`; FK to `products` is `RESTRICT` so a
  product with orders can never be deleted. `orders.user_id` cascades like
  carts do.
- **Shipping address: only `country` is strictly validated** (ISO 3166-1
  alpha-2, uppercased). `fullName`, `line1`, `city` are required free text;
  `line2`, `region` (state/province), `postalCode`, `phone` are optional
  because postal formats and required regions vary per country. No
  per-country rules are hardcoded; they become configuration behind an
  interface in a later phase (AGENTS.md §1).
- **Order currency = requested `currency`** (query param, same semantics as
  cart/catalog; default `BASE_CURRENCY`, must be supported else 400). Unit
  prices resolve with the ADR 0007 rule (fixed override or base price) and
  are frozen into `OrderItem.unit_price_amount`; `total_amount` is the plain
  integer sum. The client can only send the address — never money.
- **Creation is one Prisma transaction**: conditional `UPDATE inventory …
  WHERE (stock - reserved) >= qty` per line (same predicate as
  `InventoryService.reserve`, so concurrent checkouts cannot oversell;
  losers roll back with 409), then `order` + items insert, then cart lines
  delete. Pre-checks (non-empty cart else 422, all products `ACTIVE` else
  422, availability else 409) give friendly errors; the in-transaction
  predicate is the authority against races.
- **State machine** (`order-status.ts`): `PENDING_PAYMENT → PAID |
  CANCELLED`, `PAID → PROCESSING | CANCELLED`, `PROCESSING → SHIPPED |
  CANCELLED`, `SHIPPED → DELIVERED`, terminal `DELIVERED`/`CANCELLED`.
  Anything else throws `InvalidOrderTransitionException` (422). Customers
  can only use `POST /orders/:id/cancel` from `PENDING_PAYMENT` (releases
  the reservation); `transitionOrder()` carries the stock side effect for
  future flows — `PAID` commits (`stock` and `reserved` decrease),
  `CANCELLED` from `PENDING_PAYMENT` releases, from `PAID`/`PROCESSING`
  restocks (`stock` increases; those units were already committed).
- **Expiry**: `OrdersExpirationService` cancels `PENDING_PAYMENT` orders
  older than 30 minutes (releasing stock) via the guarded transition, in
  60-second sweeps of up to 100 candidates. In-process `setInterval`
  (unref'd, cleared on shutdown, disabled under `NODE_ENV=test`) instead of
  BullMQ: the queue infrastructure arrives in Fase 2 and a single TTL does
  not justify a new dependency now. The sweep skips orders that changed
  state concurrently and never fails the batch on one conflict.
- **Ownership**: every read/write is scoped to the caller (`findFirst`
  by `{ id, userId }`); other users' orders 404 exactly like unknown ids.
  `GET /orders` lists the caller's own orders, newest first, capped at 100
  (no pagination yet — order history volume does not justify it now).

## Consequences

- Moving expiry to BullMQ/Redis in Fase 2 needs only to replace the
  trigger (`OrdersExpirationService` timer → queue job); `transitionOrder`
  and the TTL constant stay unchanged.
- `PAID` has no producer yet (Stripe webhook in the payments task); the
  transition and its commit side effect are covered by tests so the webhook
  can call `transitionOrder(id, 'PAID')` directly.
