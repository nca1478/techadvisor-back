# 0070 — Fallo de build en Render: P3018 `type "Role" already exists`

Fecha: 2026-10-19
Estado: aceptado

## Contexto

El deploy manual `dep-dbamra3bc2fs73c0hd4g` de `techadvisor-back` falló en el
build con `prisma migrate deploy`:

```
Applying migration `20261006181636_enable_pgvector`
Applying migration `20261006192602_add_auth_user_refresh_token`
Error: P3018 — Database error code 42710: type "Role" already exists
```

El `buildCommand` del Dashboard era
`npm ci && npm run db:setup && npm run build`, donde `db:setup`
(`package.json:17`) encadena `generate + migrate deploy + seed + seed:documents`.
`render.yaml` en git, en cambio, define
`buildCommand: npm ci && npx prisma generate && npm run build` con
`preDeployCommand: npx prisma migrate deploy`: el Dashboard había derivado del
Blueprint. Además, los seeds se niegan con `NODE_ENV=production`, así que
`db:setup` nunca es válido en Render.

El P3018 significa que la BD ya contenía el enum `Role` pero
`_prisma_migrations` no registraba las migraciones aplicadas (BD creada por
otra vía o historial perdido), así que `migrate deploy` intentó reaplicar
desde cero. El mismo commit había desplegado bien antes (`live`), por lo que
el reintento manual no era idempotente en ese estado.

## Decisión

- El build de Render NUNCA migra ni siembra. Comandos canónicos del Dashboard:
  - Build: `npm ci && npx prisma generate && npm run build`
  - Pre-deploy: `npx prisma migrate deploy`
  - Start (free, un solo contenedor, ADR 0067): `npm run start:free`
- `backend/render.yaml` se alinea al tier free activo (un Web Service) y deja
  constancia de que `db:setup` es solo local.
- Recuperación del P3018 (una vez, contra la BD de producción desde una
  máquina con `DATABASE_URL` de Supabase):
  1. `npx prisma migrate status` para ver qué está pendiente.
  2. Por cada migración ya aplicada en la BD pero no registrada,
     `npx prisma migrate resolve --applied "<nombre>"`
     (empezando por `20261006192602_add_auth_user_refresh_token`).
  3. Reintentar el deploy sin limpiar caché. No usar `--rolled-back` salvo que
     la migración esté a medio aplicar.

## Consecuencias

- El deploy fallido no afectó al `live` anterior; solo bloqueó la promoción.
- Tras corregir el `buildCommand` en el Dashboard y marcar como aplicadas las
  migraciones ya existentes, `migrate deploy` vuelve a ser idempotente.
- No hay cambios de código ni migraciones nuevas; solo configuración y runbook.
