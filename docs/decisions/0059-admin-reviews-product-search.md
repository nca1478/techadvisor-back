# 0059 — Filtro de reseñas por nombre del producto (admin)

Fecha: 2026-10-16

## Contexto

La moderación de reseñas del admin solo filtraba por estado. Se pide
filtrar por el nombre del producto reseñado.

## Decisión

- Nuevo query param `q` en `GET /admin/reviews` (misma regla que el
  resto de `q` del admin: `trim`, 1–100, opcional). Filtra por nombre
  del producto (`contains`, insensible a mayúsculas).
- Sin cambios de esquema: filtro sobre la relación `product`.

## Consecuencias

- Combinable con `status` y `productId`.
