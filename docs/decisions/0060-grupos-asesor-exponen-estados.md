# 0060 — Grupos del asesor exponen estados para no ofrecer retrocesos

Fecha: 2026-10-17
Estado: aceptado

## Contexto

El panel admin agrupa preguntas sin respuesta por texto normalizado
(`GET unanswered/groups`) y aplica la acción del grupo a cada fila. El grupo
solo devolvía `ids`, sin estados: con filtro "Todos los estados" el panel
mostraba "Revisar" (`NEW ← IN_REVIEW`) también sobre grupos totalmente
`RESOLVED` (p. ej. "celulares", "audífonos" con abiertas = 0). El backend
rechaza correctamente el retroceso `RESOLVED → IN_REVIEW` con 400
("triage only moves forward"), y ese mensaje crudo llegaba al banner.

## Decisión

- `GET unanswered/groups` añade `statuses: string[]` (aditivo, sin
  migración): estados distintos del bucket ordenados
  `NEW → IN_REVIEW → RESOLVED`.
- El frontend oculta "Revisar" si el grupo no contiene `NEW` y oculta
  "Resolver" si el grupo está totalmente `RESOLVED`; el envío por grupo
  ignora los 400 de retroceso por fila (éxito parcial) para buckets mixtos.

## Consecuencias

- `RESOLVED` sigue siendo terminal; el backend no cambia su regla.
- Contrato OpenAPI crece de forma compatible; regenerar tipos con
  `npm run api:types`.
