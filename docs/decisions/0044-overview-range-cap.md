# 0044 — Tope de 366 días en el overview (anti-abuso sin rate-limit propio)

Fecha: 2026-10-13
Estado: aceptado

## Contexto

ADR 0043 dejó pendiente acotar el overview ante rangos enormes (cientos de
buckets + lectura de todos los cobrados del rango). Opciones: rate-limit
propio, tope de rango, o paginación del gráfico.

## Decisión

- Tope duro: `from`/`to` separados por más de 366 días → 400
  (`"from"/"to" range must span at most 366 days`). Acota a la vez los
  buckets (<= 367 diarios, siempre 24 por hora) y la ventana `createdAt`
  escaneada (indexada). Helper puro `rangeExceedsCap` + spec unitario y caso
  e2e; el frontend (máx. 30 días) no cambia.
- Sin rate-limit propio: los throttlers con nombre (`auth`, `search`,
  `advisor`, ver ADR 0022) cubren superficies públicas con env dedicada;
  las rutas `/admin/*` son solo-ADMIN autenticado y la restricción 5 de
  AGENTS.md solo exige rate limiting en `/auth/*` y `/advisor/*`. Un
  throttler nuevo pediría env, config y docs para un riesgo que el tope ya
  acota de forma determinista.
- Se descarta la paginación del gráfico a 12 meses: más piezas (backend +
  frontend) para un rango que el dashboard no pide.

## Consecuencias

- Un rango de >366 días falla explícito en vez de degradarse en silencio;
  si el negocio pide comparativas anuales, el endpoint ya devuelve los
  bounds efectivos y se puede subir el tope en un ADR posterior.
