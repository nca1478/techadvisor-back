# 0057 — Historial de estados del pedido con fecha/hora

Fecha: 2026-10-16

## Contexto

El detalle del pedido mostraba junto al badge la fecha de creación del
pedido, no la fecha de cada cambio de estado. Se pide registrar y mostrar
fecha/hora por cada transición.

## Decisión

- Nueva tabla aditiva `order_status_history` (`id`, `order_id` FK con
  cascade, `from_status` anulable —`NULL` = entrada inicial en la
  creación—, `to_status`, `created_at`, `updated_at`).
- Cada cambio de estado inserta una fila en la misma transacción que
  actualiza `orders.status`: `OrdersService.transitionOrder` (webhook de
  pago, expiración, admin), `cancelOrder` (cliente) y `createOrder`
  (entrada inicial `NULL → PENDING_PAYMENT`).
- La historia se expone en `OrderResponseDto.statusHistory` y
  `AdminOrderDto.statusHistory` (`[{ from, to, at }]`, orden
  cronológico), para que el frontend pinte la fecha bajo cada paso de la
  línea de tiempo y use el último cambio en la cabecera.
- Sin backfill SQL de transiciones pasadas (sería inventar datos): los
  pedidos anteriores a esta migración solo tendrán la entrada inicial si
  se recrean; la API devuelve lo que haya y el frontend aplica fallback a
  `createdAt` (paso inicial) / `updatedAt` (estado actual).

## Consecuencias

- Migración solo aditiva; ningún cambio destructivo.
- Una fila por transición: crecimiento lineal y acotado por pedido.
