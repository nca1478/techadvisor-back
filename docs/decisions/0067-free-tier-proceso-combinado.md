# 0067 — Tier gratis: API + worker en un solo contenedor

Fecha: 2026-10-18
Estado: aceptado

## Contexto

Render no ofrece Background Workers en el plan free y el usuario administra
Postgres (Supabase) y Redis (Upstash) por fuera. La topología de referencia
sigue siendo un servicio por proceso (ADR 0019, `render.yaml`, ADR 0066).

## Decisión

Añadir `npm run start:free` (`src/run-free.ts` → `dist/run-free.js`): un
launcher sin dependencias que levanta `dist/main.js` y
`dist/modules/ingestion/ingestion.worker.js` como hijos en el mismo
contenedor, reenvía SIGTERM/SIGINT y sale cuando cualquiera de los dos
termina para que Render reinicie el par completo.

## Consecuencias

- $0: un solo Web Service free ejecuta API + ingesta.
- Se acepta acoplamiento: un OOM o crash del worker reinicia también la API
  (y viceversa); logs mezclados en la misma salida; escala acoplada.
- El plan free duerme el servicio por inactividad: la ingesta encolada se
  procesa al despertar.
- Sin disco persistente en free: `DOCUMENTS_DIR` se pierde en cada deploy
  (ver ADR 0020); aceptado para hobby.
- Para producción, volver a `start:prod` + Background Worker (ADR 0066).
