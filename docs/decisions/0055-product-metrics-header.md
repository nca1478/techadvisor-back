# 0055 — Métricas de catálogo en el header de productos

Fecha: 2026-10-16
Estado: aceptado

## Contexto

El módulo de productos no mostraba totales: total, activos, poco stock y
sin stock. Las definiciones de stock ya existían (filtro `stock` del
listado y conteos `attention` del overview): disponible = `stock -
reserved`, `low_stock` inclusivo de `out_of_stock` con umbral 5.

## Decisión

- Nuevo `GET /api/v1/admin/products/metrics` (antes de `products/:id` para
  no colisionar): `{ total, active, lowStock, outOfStock, inStock,
  reserved, lowStockThreshold }` en una transacción (2 conteos + filas de
  `inventory`). `lowStockThreshold` parametrizable, defecto 5. `inStock` es
  disponible > 0 y `reserved` es `reserved` > 0 (conteos de productos).
- El frontend lo pide en la page de productos (server-fetch con cookies) y
  pinta 4 tarjetas KPI en una línea: total → lista sin filtros, activos →
  `?status=ACTIVE`, poco/sin stock → inventario con el filtro
  correspondiente. Inventario reutiliza el mismo endpoint con 5 tarjetas
  (total, en stock, poco stock, sin stock, reservados), sin enlaces.

## Consecuencias

- Sin cambios en listados ni filtros; el tipo frontal es local hasta
  regenerar con `npm run api:types`.
