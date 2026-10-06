# 0003 — Prisma 7 + PostgreSQL + pgvector, typed env config

Date: 2026-10-06
Status: accepted

## Context

The backend needs a typed, validated configuration (Zod) and Prisma connected to
the Docker Compose PostgreSQL (image `pgvector/pgvector:pg16`), with the
`vector` extension enabled. Versions were checked with the Context7 MCP
(library `/prisma/web`) and `npm view` before installing.

**Local port conflict (this machine):** a native Windows PostgreSQL occupies
host port `5432`, so `localhost:5432` answers from the wrong server (auth
fails). The committed `docker-compose.yml` still publishes `5432`; machines
with this conflict use a gitignored `docker-compose.override.yml` remapping
the host port to `5433` and point the local (gitignored) `.env` `DATABASE_URL`
at `localhost:5433`. CI and clean machines keep using `5432` untouched.

## Decision

- **Prisma ORM `7.10.0` pinned** (`prisma@7.10.0` devDependency,
  `@prisma/client@7.10.0` + `@prisma/adapter-pg@7.10.0` dependencies).
  `npm view prisma version` currently resolves to `8.0.0-rc.20` (a pre-release
  on the `latest` tag), so we pin the latest stable v7 explicitly and revisit
  the v8 upgrade via a new ADR once it is stable.
- **Prisma 7 layout**: connection URL lives in `prisma.config.ts`
  (`datasource.url = env("DATABASE_URL")`), not in `schema.prisma`. Client
  generator uses `provider = "prisma-client"` with
  `output = "../src/generated/prisma"` and `moduleFormat = "cjs"` (per the Prisma +
  NestJS docs, prevents runtime errors when NestJS loads the generated client).
  Output lives under `src/` so `nest build` (rootDir `src`) compiles; the
  generated client is gitignored (`generated/`) and produced with
  `npx prisma generate` (runs automatically via `postinstall`).
- **Driver adapter pattern**: `PrismaService` extends `PrismaClient` built with
  `new PrismaPg({ connectionString })` from `@prisma/adapter-pg` over the `pg`
  driver (`pg@8.23.1`, `@types/pg@8.23.1` dev). This is the documented Prisma 7
  + NestJS setup (driver adapters are mandatory in v7).
- **`.env` loading**: `dotenv@18.0.5` (`import 'dotenv/config'`) in `main.ts`
  and `prisma.config.ts`. No `@nestjs/config`: plain `process.env` + a Zod
  schema in `src/config/` is simpler and already satisfies the "fail fast with
  a legible message" requirement.
- **First migration is extension-only**: `CREATE EXTENSION IF NOT EXISTS
  vector;` (additive, no models yet per the task constraints). Business tables
  (`Document`, `Chunk`, …) arrive in Fase 2 with their `vector(N)` columns.

## Versions pinned (2026-10-06)

- `prisma@7.10.0`, `@prisma/client@7.10.0`, `@prisma/adapter-pg@7.10.0`
- `pg@8.23.1`, `@types/pg@8.23.1`, `dotenv@18.0.5`, `zod@4.6.5` (already present)

## Consequences

- `npx prisma migrate dev` applies cleanly on an empty database; re-running is
  idempotent (`IF NOT EXISTS` + migration history table).
- `DATABASE_URL` missing or invalid fails the boot with a readable Zod error
  listing every offending variable.
- Prisma Client must be regenerated after schema changes
  (`npx prisma generate`, automatic on `npm ci` via `postinstall`).
