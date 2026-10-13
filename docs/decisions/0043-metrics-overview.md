# 0043 — GET /admin/metrics/overview (agregación exacta del dashboard)

Fecha: 2026-10-13
Estado: aceptado

## Contexto

El dashboard calculaba KPIs en el frontend desde muestras acotadas
(`limit=20/100`, ADRs 0035/0036 del frontend): ingresos y gráfico parciales.
Se necesita una agregación exacta sin exponer filas.

## Decisión

- `GET /admin/metrics/overview` (ADMIN, como todo `/admin/*`) con query
  `from`/`to` ISO opcionales (misma validación que `listOrders`, incluido
  `from <= to`), `granularity=hour|day` (defecto `day`) y
  `lowStockThreshold` (entero 1..1000, defecto 5: espeja el `LOW_STOCK_THRESHOLD`
  del frontend por contrato, sin código compartido).
- Sin bounds: últimos 7 días UTC (`day`) o día UTC de `to` (`hour`); la
  respuesta siempre devuelve los bounds efectivos (`from`/`to`).
- Una sola transacción Prisma: `order.count` + `groupBy status` en rango,
  `findMany` de cobrados (`PAID, PROCESSING, SHIPPED, DELIVERED`) con
  `select` mínimo, `inventory` completo (stock/reservado son pocos miles de
  filas), `review PENDING`, `document FAILED` no borrados (mismo filtro que
  el listado), `unansweredQuery NEW|IN_REVIEW` (mismo criterio que
  `getMetrics`). El agrupado por moneda y los buckets se hacen en TS
  (exactos, sin límite de 100).
- Buckets en la moneda modal (null si no hay cobros); `revenue` por moneda
  ordenado por importe desc; `byStatus` ordenado alfabéticamente
  (determinista). Dinero siempre en unidades menores.
- Lógica pura en `metrics-overview.ts` (precedente: `advisor/query-normalize.ts`)
  con spec unitario; endpoint con e2e propio (`test/admin-metrics.e2e-spec.ts`,
  ventana fija 2024 para aserciones exactas + limpieza en `afterAll`).
- Sin migraciones (solo lecturas) y sin dependencias nuevas.

## Consecuencias

- El frontend consume el overview y elimina sus 4 fetches de agregación;
  conserva `recentOrders` (tabla) y sus guards (tipos regenerados vía
  `npm run api:types` con el backend en marcha).
- Reparación de contrato hallada al regenerar: `AdminOrderDto.userName`
  declaraba `nullable: true` sin `type` y el OpenAPI lo emitía como
  `object` (los clientes veían `Record<string, never>`). Se añadió
  `type: String` explícito (solo-docs, sin comportamiento).
- Rangos enormes (p. ej. un año en `day`) devuelven cientos de buckets y
  leen todos los cobrados: aceptable para un endpoint ADMIN autenticado;
  si se abusa, añadir rate limit o tope en un ADR posterior.
