# 0074 — Varios documentos manuales por producto (`source` único por documento)

- Estado: aceptado.
- Fecha: 2026-10-19.
- Contexto: `documents` tiene `@@unique([productId, source])`, diseñado para que
  cada producto tenga como máximo un SPEC_SHEET auto-generado
  (`source = 'auto:product'`). Pero las subidas manuales y los registros por URL
  usaban todos `source = 'manual'`, así que la BD solo admitía **un** documento
  manual por producto. La segunda subida para el mismo producto fallaba con
  Prisma P2002 no capturado → `500 INTERNAL_ERROR` en
  `POST /api/v1/admin/documents/upload` (producción, 2026-10-19).
- Decisión: cada documento manual recibe `source = 'manual:<documentId>'`
  (helper `manualDocumentSource()` en `ingestion.constants.ts`; el id se genera
  en el servicio con `randomUUID()`). Filas antiguas con el valor heredado
  `'manual'` siguen funcionando: nada filtra por `source === 'manual'`
  (búsqueda usa `type`/`productId`/vectores; seeds y `product-spec-sheet`
  solo tocan sus propios prefijos `seed:*` y `auto:product`).
- Alternativa descartada: reemplazar el unique por un índice parcial solo para
  `auto:product`. Requería `DROP` del constraint existente (migración no
  aditiva, prohibida sin proceso en dos pasos) para un beneficio idéntico.
- Además: colisiones únicas (P2002) en este servicio se mapean a `409 Conflict`
  con mensaje legible (mismo patrón que `AdminService.toUniqueConflict`); esa
  clase de error no vuelve a salir como 500.
- Consecuencias: sin migración (cambio solo de código); contrato OpenAPI sin
  cambios (`source` sigue siendo string opaco, ya expuesto en el DTO).
