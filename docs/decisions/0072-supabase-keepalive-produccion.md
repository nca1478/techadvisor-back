# 0072 — Keep-alive de la base de datos Supabase en producción

Date: 2026-10-19
Status: accepted

## Context

Supabase pausa la base de datos del tier free tras inactividad prolongada y
el primer request posterior despierta con latencia alta o timeout. La base
local (`docker-compose.yml`, PostgreSQL 16) nunca se duerme, así que el ping
solo tiene sentido en producción. Referencia existente:
`05-control-asistencia-opencode/backend/src/modules/keepalive/`
(`KeepAliveService` con `SELECT 1` cada `KEEPALIVE_INTERVAL_MINUTES`,
activado por `KEEPALIVE_ENABLED`).

## Decision

Nuevo módulo `src/modules/keepalive/` (`KeepAliveModule` +
`KeepAliveService`, sin controlador) adaptado a la arquitectura TechAdvisor:

- Inyecta el `PrismaService` global y la config tipada `APP_CONFIG`
  (`env.schema.ts`); el ping usa `` $queryRaw`SELECT 1` `` como
  `HealthService.checkDb`, no `$queryRawUnsafe`.
- Config (`env.schema.ts`): `KEEPALIVE_ENABLED` booleano con default
  **`false`** (al revés que el proyecto 05, cuyo default es `true`) para que
  desarrollo nunca pinguee; `KEEPALIVE_INTERVAL_MINUTES` entero 1–1440 con
  default `60` (mismo intervalo que la referencia). Producción (Dashboard de
  Render) fija `KEEPALIVE_ENABLED=true`.
- Nunca corre bajo `NODE_ENV=test` (mismo guard que
  `OrdersExpirationService`) para mantener las suites deterministas.
- Fallos del ping solo emiten `warn`, nunca tumban la API; el intervalo usa
  `unref()` y se libera en `onModuleDestroy`.
- Sin migración de BD, sin endpoint nuevo, sin dependencias nuevas.

## Consequences

- Producción mantiene Supabase despierta con ~24 `SELECT 1`/día; desarrollo
  mantiene cero dependencias de red nuevas.
- El plan free de Render sigue durmiendo el servicio por inactividad HTTP:
  este módulo evita la pausa de la **base de datos**, no la del contenedor
  web (ver ADR 0066).
- `.env.example` documenta ambas variables; tests en
  `keepalive.service.spec.ts` + casos de `env.schema.spec.ts`.
