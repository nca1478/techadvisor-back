# 0014 — Idempotent Prisma seed run with tsx, base currency only

Date: 2026-10-06
Status: accepted

## Context

The project needs realistic dev/demo data (~40 products, categories, brands,
test users) via an idempotent `npm run seed`. The seed is TypeScript and
reuses the Zod specs schemas in `src/modules/catalog/specs/`, whose files
import each other with explicit `.js` extensions (NodeNext style).

## Decision

- **Runner: `tsx@4.23.15` (devDependency).** Plain `node` type-stripping was
  evaluated and rejected: it does not resolve the `.js` → `.ts` specifiers
  used across `src/` (`ERR_MODULE_NOT_FOUND` for `spec-fields.js`),
  so the seed cannot reuse the specs schemas without a loader. `tsx`
  resolves them correctly. No other new dependency is needed
  (`dotenv`, `argon2`, `zod`, `@prisma/adapter-pg` already exist).
- **Note on MCP context7:** it was not available in this environment, so the
  version was resolved with `npm view tsx version` (4.23.15) per AGENTS.md §2.
- **Idempotency via upserts:** categories/brands by `slug`, products by `sku`
  (both `@unique`), translations by their composite keys, inventory by
  `productId`. Images are replaced (`deleteMany` + `createMany`) per product
  so re-runs converge instead of duplicating.
- **Currency:** seed writes only the base price (`price_amount` in
  `BASE_CURRENCY`, read from env, `USD` locally). No `product_prices` rows,
  per ADR 0007 ("overrides are absent in this phase").
- **Safety:** the script refuses to run when `NODE_ENV=production`.
- **Test users** (`admin@techadvisor.local` / `customer@techadvisor.local`)
  are dev-only fixtures; credentials are documented in `README.md`, never
  used outside local development.

## Consequences

- `npm run seed` = `tsx prisma/seed.ts`; safe to run repeatedly.
- `prisma/seed-data/seed-data.spec.ts` re-validates every JSON row against
  `parseSpecs`/`imageUrlSchema`, so `npm test` guards the fixtures.
