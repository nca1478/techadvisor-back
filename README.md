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

## Scripts

| Script            | What it does                    |
|-------------------|---------------------------------|
| `npm run dev`     | start in watch mode (port 3001) |
| `npm run build`   | compile to `dist/`              |
| `npm run lint`    | oxlint (type-aware)             |
| `npm run typecheck` | `tsc --noEmit`                |
| `npm test`        | unit tests (vitest)             |
| `npm run test:e2e`| API e2e tests (vitest + supertest) |

## Layout

- `src/modules/` — feature modules (catalog, orders, …)
- `src/common/` — filters, guards, interceptors, utils
- `src/config/` — env-validated configuration
