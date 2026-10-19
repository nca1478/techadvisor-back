# 0068 — Seeders crear-si-no-existe (patrón 05-control-asistencia)

Fecha: 2026-10-19
Estado: aceptado

## Contexto

Los seeders del backend (`prisma/seed.ts`, `prisma/seed-documents.ts`,
`prisma/seed-policies.ts`) usaban `upsert` con `update` que sobrescribía
filas existentes, o re-procesaban documentos cuando cambiaba el hash. Se
pide el patrón del proyecto `05-control-asistencia-opencode`: si el
registro no existe se crea, si existe no se toca.

## Decisión

- `prisma/seed.ts`: `upsert` con `update: {}` en categorías, marcas,
  traducciones e inventario; usuarios y productos con verificación previa
  de existencia (`findUnique` por `email`/`sku`): si existe se omite por
  completo (sin re-hashear contraseñas, sin borrar/recrear imágenes, sin
  tocar stock).
- `prisma/seed-documents.ts` y `prisma/seed-policies.ts`: verificación
  previa por `source` (ficheros) o `(productId, source)` (spec sheets): si
  existe se retorna `skipped` sin extraer, sin llamar al proveedor de
  embeddings y sin revivir filas soft-deleted.
- Logs unificados: `SKIPPED (exists)`.

## Consecuencias

- Re-ejecutar seeders es barato y seguro: no genera llamadas de embeddings
  para documentos ya presentes y preserva ediciones manuales/admin.
- Cambiar un fixture JSON o un markdown NO actualiza la fila existente;
  para aplicar el cambio hay que borrar la fila (o la BD) y re-ejecutar.
  Es el comportamiento pedido explícitamente.
- La ingesta productiva (`IngestionService`) no cambia: sigue con su lógica
  hash-based de skip-or-reprocess.
