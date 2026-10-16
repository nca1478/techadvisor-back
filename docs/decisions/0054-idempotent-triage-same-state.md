# 0054 — Triaje idempotente ante mismo estado

Fecha: 2026-10-16
Estado: aceptado

## Contexto

`PATCH /admin/advisor/unanswered/:id` rechazaba con 400 los movimientos al
mismo estado. Las agrupaciones por frecuencia (`GET unanswered/groups`)
mezclan estados, y el panel aplica la acción del grupo a cada fila: pulsar
"Revisar" sobre un grupo con filas ya en `IN_REVIEW` fallaba entero con
"Cannot move unanswered query from IN_REVIEW to IN_REVIEW".

## Decisión

- El movimiento al mismo estado es un no-op que devuelve la fila actual
  (200, sin `UPDATE`). Solo los retrocesos siguen siendo 400; `RESOLVED`
  sigue siendo terminal.
- El frontend no cambia: sus PATCH secuenciales por grupo ahora tienen éxito
  en filas nuevas y en las que ya tenían el estado.

## Consecuencias

- Matiza al ADR 0040 ("reabrir se rechaza"): reabrir (retroceder) se sigue
  rechazando; repetir el estado actual es idempotente, como corresponde a
  `PATCH`.
