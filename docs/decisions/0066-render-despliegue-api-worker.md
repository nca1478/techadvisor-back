# 0066 — Despliegue en Render: API + worker de ingesta

Fecha: 2026-10-18
Estado: aceptado

## Contexto

El backend tiene dos procesos (ADR 0019): la API (`npm run start:prod`)
solo encola trabajos BullMQ y el worker (`npm run worker:ingestion`) los
consume. Render ejecuta un solo comando por servicio, así que el despliegue
requiere dos servicios del mismo repo `techadvisor-back`.

## Decisión

- `techadvisor-back` (Web Service, plan free): `npm run start:prod`,
  health check en `/api/v1/health`,
  `preDeployCommand: npx prisma migrate deploy`.
- `techadvisor-worker-ingestion` (Background Worker, plan starter — Render
  no ofrece workers en free): `npm run worker:ingestion`.
- `backend/render.yaml` (Blueprint) versiona ambos servicios; Postgres
  (Supabase, con extensión `vector`) y Redis externo quedan fuera de Render.
- Secretos (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CORS_ORIGINS`) con
  `sync: false`: se cargan en el Dashboard, nunca en el repo.
- `NODE_VERSION=24`: el `package-lock.json` se genera con npm 11; con
  Node 22 (npm 10) el `npm ci` de Render falla por lock desincronizado.
- Disco persistente de 1 GB en `storage/documents`: el filesystem de Render
  es efímero y los uploads se perderían en cada deploy (ADR 0020).

## Consecuencias

- El worker de reindex (`npm run worker:reindex`) no se despliega de forma
  permanente; se levanta bajo demanda cuando haya un cambio de modelo
  (ADR 0023).
- El plan free duerme la API por inactividad; para producción pasar a
  starter.
