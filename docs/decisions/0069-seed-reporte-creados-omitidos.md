# 0069 — Seeders informan creados y omitidos por tabla

Fecha: 2026-10-19
Estado: aceptado

## Contexto

Con el patrón crear-si-no-existe (ADR 0068), una re-ejecución de los
seeders omite casi todo en silencio. Se pide que cada seeder informe qué
tablas ganaron filas y qué tablas fueron omitidas, con cantidades.

## Decisión

- `prisma/seed.ts`: imprime una línea por tabla con el formato
  `seed: <tabla> → created=N skipped=M` para `categories`,
  `categoryTranslations`, `brands`, `users`, `products`, `productImages`,
  `productTranslations` e `inventory`. La partición nuevo/existente se
  resuelve con un `findMany` por claves de negocio antes de escribir; los
  hijos de productos omitidos se cuentan con `count` por `productId`.
- `prisma/seed-documents.ts`: imprime `created — documents=N chunks=M`,
  `skipped — documents=N chunks=M`, el desglose por tipo
  (`POLICY`/`FAQ`/`WARRANTY`) y la línea de `SPEC_SHEET`. Los chunks
  omitidos se cuentan con un único `count` sobre los documentos omitidos.
- `prisma/seed-policies.ts`: imprime `created`/`skipped` para las tablas
  `documents` y `chunks` con el mismo criterio.

## Consecuencias

- Cada ejecución deja trazabilidad de lo creado y lo omitido sin costo
  relevante (lecturas por lotes + un `count` por tabla hija).
- Los logs por archivo (`READY` / `SKIPPED (exists)`) se mantienen; el
  resumen por tabla se agrega al final.
