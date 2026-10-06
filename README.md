# TechAdvisor — Backend

NestJS API for the TechAdvisor tech ecommerce (B2C) with a RAG shopping advisor.
Listens on port **3001** with global prefix **`/api/v1`**.

> Source of truth: [`../AGENTS.md`](../AGENTS.md).

## Run

```bash
npm ci
npm run dev      # watch mode on http://localhost:3001
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
