# 0010 — Guest + user carts with merge on login

Date: 2026-10-06
Status: accepted

## Context

AGENTS.md §6 defines `Cart(id, user_id?, session_id?, …)` /
`CartItem(cart_id, product_id, qty)` with merge of the guest cart into the
user cart at login. No new dependencies were installed for this task (no
`cookie-parser`: the signed `sid` cookie is implemented with `node:crypto`
HMAC, ~30 lines). Context7 MCP is not active in this environment, and since
no package was installed no version lookup was needed.

## Decision

- **Tables `carts` / `cart_items`** (additive migration `add_cart`): `carts`
  has nullable `user_id` (FK to `users`, cascade) and nullable `session_id`,
  each with a `UNIQUE` index (in PostgreSQL multiple `NULL`s never conflict,
  so "one cart per user / per session" holds exactly for set values).
  `cart_items` has `@@unique([cartId, productId])`, `qty` validated at the
  API/service layers (Zod + service guard); FKs cascade on delete.
- **Guest identity: httpOnly `sid` cookie, HMAC-signed.** Value
  `<uuid>.<hmac-sha256(uuid, JWT_SECRET)>` (reuses `JWT_SECRET`, no new env
  var). Verification uses `timingSafeEqual`; tampered/foreign cookies are
  treated as absent and a fresh session is issued. Cookie flags: `HttpOnly`,
  `Path=/`, `SameSite=Lax`, `Max-Age=30 days`. No `Secure` flag yet: local
  dev runs over plain HTTP; must be revisited (ADR) when HTTPS is deployed.
- **Quantities beyond available stock are REJECTED (HTTP 409
  `InsufficientStockException`, same shape as inventory errors)** on
  `POST /cart/items` and `PATCH /cart/items/:productId`, for both the added
  line and the resulting line total. Rationale: explicit feedback beats
  silent adjustment at add-to-cart time; the cart response always carries
  `sufficientStock`/`inStock` so the UI can warn before checkout.
- **Merge (`POST /cart/merge`, authenticated) SUMS guest + user quantities
  but CAPS each line at the available stock** (`min(sum, available)`);
  lines with zero availability are dropped. Rationale: the task mandates
  "sumando cantidades hasta el stock disponible"; capping (instead of
  rejecting) avoids losing the guest cart on login. The merged cart is
  returned; the guest cart row is deleted and the `sid` cookie cleared.
- **No stock is reserved by cart operations** (reservation happens only at
  order creation via `InventoryService`). Cart stock checks are read-only
  (`getAvailable`/`getAvailabilityMap`); a checkout race is resolved later
  by the atomic reservation.
- **Prices and totals are NEVER accepted from the client and NEVER stored.**
  Every cart response is computed server-side from `products` +
  `product_prices` (override-per-currency fallback per ADR 0007) in the
  requested `currency` (default `BASE_CURRENCY`, must be supported else 400)
  and localized names per ADR 0008. Each item exposes `name`, `imageUrl`
  (primary image, lowest `position`), `unitPriceAmount`, `lineTotalAmount`,
  `inStock`, `sufficientStock` and `availableQuantity` (capped at 10, same
  no-leak rule as the catalog); products that are no longer `ACTIVE` are
  flagged `inStock: false, sufficientStock: false` (checkout will reject
  them later) but still counted in the total so it always equals the sum of
  the displayed line totals.
- **Per-line quantity bound:** `1..999` (Zod). `PATCH` with `qty: 0` is a
  400 — removal uses `DELETE`.

## Consequences

- Login clients should call `POST /cart/merge` right after obtaining tokens;
  without it the guest and user carts stay separate (documented behavior).
- Exact stock is never exposed; `sufficientStock` is computed from the exact
  server-side count so it stays accurate even above the visible cap.
- When HTTPS is deployed, add `Secure` (and revisit `SameSite`) for `sid`.
