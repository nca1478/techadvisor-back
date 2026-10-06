# TechAdvisor — Backend

NestJS API for the TechAdvisor tech ecommerce (B2C) with a RAG shopping advisor.
Listens on port **3001** with global prefix **`/api/v1`**.

> Source of truth: [`../AGENTS.md`](../AGENTS.md).

## Run

```bash
npm ci
npm run dev      # watch mode on http://localhost:3001
```

## Infrastructure (PostgreSQL + pgvector, Redis)

Local infrastructure runs via Docker Compose from this folder (`backend/`).
The API and web run with `npm run dev` — no Dockerfiles.

```bash
cp .env.example .env          # once: create your local env file (never commit .env)
docker compose up -d          # start postgres (5432) + redis (6379)
docker compose ps             # both services should show "healthy"
docker compose down           # stop the infrastructure (keeps data volumes)
docker compose down -v        # stop AND delete data volumes (fresh start)
```

> If host port `5432` is already taken on your machine (e.g. a native
> PostgreSQL), create a gitignored `docker-compose.override.yml` remapping it
> (e.g. `"5433:5432"` for `postgres`) and point your local `.env`
> `DATABASE_URL` at that port. See ADR `0003`.

## Database (Prisma)

```bash
npx prisma migrate dev   # apply pending migrations (creates the DB if needed)
npx prisma generate      # regenerate the client (also runs on `npm ci` via `postinstall`)
```

## Seed (development data only)

Idempotent fixtures: 7 categories, 10 brands, 40 products (laptops + PC
components with coherent specs), ES translations and two test users. Data
lives in `prisma/seed-data/*.json` and is validated against the category
Zod specs schemas on every run. Safe to run repeatedly — upserts on
`slug`/`sku`/email converge instead of duplicating.

```bash
npm run seed             # refuses to run with NODE_ENV=production
```

Test users (local development only, never production):

| Role     | Email                        | Password      |
|----------|------------------------------|---------------|
| ADMIN    | `admin@techadvisor.local`    | `Admin123!`   |
| CUSTOMER | `customer@techadvisor.local` | `Customer123!` |

## Scripts

| Script            | What it does                    |
|-------------------|---------------------------------|
| `npm run dev`     | start in watch mode (port 3001) |
| `npm run seed`    | load idempotent dev/demo data   |
| `npm run build`   | compile to `dist/`              |
| `npm run lint`    | oxlint (type-aware)             |
| `npm run typecheck` | `tsc --noEmit`                |
| `npm test`        | unit tests (vitest)             |
| `npm run test:e2e`| API e2e tests (vitest + supertest) |

## Payments (Stripe, test mode only)

Checkouts run behind the `PaymentProvider` interface (see ADR `0012`):
`POST /api/v1/payments/checkout { orderId }` creates a Stripe-hosted
Checkout Session from the server-side order total and returns its URL.
The Stripe webhook is the **only** source of truth for payment state —
`POST /api/v1/payments/webhook` verifies the `stripe-signature` header over
the raw body and moves the order to `PAID` (or `CANCELLED` on
failure/expiry). The frontend `success_url` redirect never changes order
state. Only test keys are accepted (`sk_test_...` / `pk_test_...`; live keys
fail boot). Without keys, `/payments/*` returns `503`.

```bash
# Local end-to-end test with the Stripe CLI (needs test-mode keys in .env):
stripe login
stripe listen --forward-to localhost:3001/api/v1/payments/webhook
# In another terminal, trigger a test payment for a checkout session:
stripe checkout sessions create --help
```

## Layout

- `src/modules/` — feature modules (catalog, orders, …)
- `src/common/` — filters, guards, interceptors, utils
- `src/config/` — env-validated configuration
