# 0045 — Filtro de stock en GET /admin/products (pantalla de inventario)

Fecha: 2026-10-13
Estado: aceptado

## Contexto

La pantalla de inventario lista productos vía `GET /admin/products` sin
forma de aislar los casos operativos: sin stock, poco stock y con
reservas. Además, la cola operativa del dashboard debe enlazar a esa
pantalla ya filtrada (solo "sin stock" y "poco stock").

## Decisión

- Query nueva en `GET /admin/products`: `stock=out_of_stock|low_stock|reserved`
  más `lowStockThreshold` (entero 1..1000, defecto 5: mismo patrón que el
  overview, espeja el `LOW_STOCK_THRESHOLD` del frontend por contrato).
- Semántica sobre unidades disponibles (`stock - reserved`):
  - `out_of_stock`: disponible <= 0.
  - `low_stock`: disponible <= umbral (inclusivo: contiene a `out_of_stock`,
    misma definición que `getMetricsOverview` y el helper `isLowStock` del
    frontend, para que los conteos del dashboard coincidan con el listado).
  - `reserved`: `reserved > 0`.
- Implementación: Prisma no puede comparar dos columnas en un `where`, así
  que el filtro resuelve los `product_id` coincidentes con un `$queryRaw`
  acotado sobre `inventory` y luego aplica `where.id IN (...)`; sin
  coincidencias devuelve lista vacía sin consultar más. Sin migraciones
  (solo lectura) y sin dependencias nuevas.

## Consecuencias

- El frontend pasa `stock` + `lowStockThreshold` desde la pantalla de
  inventario y enlaza la cola operativa a `?stock=out_of_stock` y
  `?stock=low_stock`.
- Cobertura e2e en `test/admin.e2e-spec.ts` (pertenencia de fixtures +
  invariante universal por filtro + valor inválido → 400).
