# 0058 — Filtro de pedidos por nombre del cliente (admin)

Fecha: 2026-10-16

## Contexto

La lista de pedidos del admin solo filtraba por estado. Se pide filtrar
por el nombre del usuario que hizo el pedido.

## Decisión

- Nuevo query param `q` en `GET /admin/orders` (misma regla que el `q`
  de productos: `trim`, 1–100 caracteres, opcional). Filtra por nombre
  **o** correo del comprador (`contains`, insensible a mayúsculas), ya
  que la columna Cliente de la tabla muestra el nombre y el correo es
  el otro identificador visible del comprador.
- Sin cambios de esquema: es un filtro sobre la relación `user`
  existente.

## Consecuencias

- El frontend envía `q` en la URL y el servidor lo revalida con Zod.
