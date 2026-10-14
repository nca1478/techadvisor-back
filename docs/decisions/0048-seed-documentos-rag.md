# 0048 — Seed del corpus RAG: fichas técnicas, FAQ, garantía y políticas

Fecha: 2026-10-14
Estado: aceptado

## Contexto

La lista de documentos del panel admin (`/admin/documentos`) quedaba vacía
tras `npm run db:seed`: ese script solo poblaba el catálogo y las fichas
técnicas auto (`source = 'auto:product'`) solo se creaban al escribir
productos con el worker en marcha. `seed:policies` cubría únicamente
`POLICY`, así que los asesores (producto-QA sobre SPEC_SHEET y soporte sobre
POLICY/WARRANTY/FAQ, ver ADR 0036 y `SUPPORT_DOC_TYPES`) no tenían evidencia
sembrada para funcionar bien en desarrollo/demo.

El usuario pidió sembrar vía seeder: ficha técnica (por producto), FAQ,
garantía y política, con ajustes en frontend, backend y seeder.

## Decisión

- Nuevo script canónico `prisma/seed-documents.ts` (`npm run seed:documents`
  y `npm run db:seed:documents`): superset idempotente que deja la lista del
  admin con los 4 tipos pedidos:
  - **SPEC_SHEET por producto ACTIVE** (`source = 'auto:product'`, mismo
    markdown de `buildSpecSheetText` que el hook de catálogo, `locale =
    DEFAULT_LOCALE`, enlazado a `productId`/`categoryId`).
  - **FAQ** desde `docs/content/faqs/<locale>/*.md` (`type: FAQ`,
    `source = 'seed:faq:<locale>:<slug>'`): `general.md` +
    `compatibilidad.md`/`compatibility.md` por idioma.
  - **WARRANTY** desde `docs/content/warranty/<locale>/*.md`
    (`source = 'seed:warranty:<locale>:<slug>'`): `cobertura.md`/`reclamar.md`
    y `coverage.md`/`claim.md` (duración por categoría, cobertura,
    exclusiones, procedimiento de reclamo que deriva al soporte humano).
  - **POLICY** desde `docs/content/policies/<locale>/*.md`
    (`source = 'seed:policy:<locale>:<slug>'`, misma cobertura que el legacy
    `seed-policies.ts`, que se conserva sin cambios para no romper flujos).
- Idempotencia por `content_hash`: re-ejecuciones omiten lo no cambiado
  (mismo nº de chunks, sin llamar al proveedor) y reavivan filas
  soft-deleted del seed (`deletedAt → NULL`). Subidas manuales
  (`source = 'manual'`) nunca se tocan. Pipeline idéntico al de ingesta
  (extract → hash → chunk → embeddings en lote → persistencia transaccional),
  sin Redis/worker, con `EMBEDDING_PROVIDER=fake` en local.
- Sin cambios de esquema ni endpoints: `DocumentType` ya incluía los 4 tipos
  y `/admin/documents` ya filtra por `type`/`status`. Ajuste backend mínimo:
  scripts + README.
- Ajuste frontend mínimo: la tabla de documentos muestra el **origen**
  (`source`: `auto:product`, `seed:faq:…`, `seed:warranty:…`,
  `seed:policy:…`, `manual`) junto a locale/archivo/URL, para distinguir de
  un vistazo los documentos sembrados de los subidos a mano. Sin filtros
  nuevos (el filtro por tipo ya cubre los 4 tipos pedidos).
- Contenidos marcados como plantilla a revisar por el negocio, igual que las
  políticas existentes; duraciones coherentes con `garantia.md/warranty.md`
  (portátiles 2 años, componentes 3, periféricos 1).

## Consecuencias

- `npm run db:seed && npm run seed:documents` deja una SPEC_SHEET por
  producto ACTIVE (273 en el seed actual) + 10 POLICY + 4 FAQ + 4 WARRANTY,
  todos READY en el panel, y los asesores responden con citas sin necesidad
  de subir nada a mano.
- Requiere BD migrada + `DATABASE_URL` + embeddings configurados (fake por
  defecto en local). Se niega en producción (`NODE_ENV=production`).
- Si el admin borra un documento seed, el próximo seed lo restaura; para
  eliminarlo de forma permanente hay que borrar el `.md` (o el producto) y
  re-ejecutar, o borrarlo tras sembrar sin re-ejecutar.
- Cambio de modelo de embeddings: re-ejecutar el seed con el nuevo modelo
  regenera vectores (mismo procedimiento que la ingesta normal).

## Addendum 2026-10-14 — columnas RAG eliminadas por una migración a la deriva

Al ejecutar el seed en local se descubrió que la BD de desarrollo no podía
insertar chunks (`record "new" has no field "tsv"`): la migración
`20261014005223_add_another_migration` (autogenerada por `prisma migrate
dev`) había eliminado `tsv`, `embedding`, `embedding_halfvec`,
`embedding_v2` y sus índices, porque Prisma no modela esas columnas (son
propiedad de SQL manual) y las vio como "sobrantes". Esto rompía toda la
ingesta RAG, no solo el seed (5 suites de integración fallaban igual).

Reparación: migración **aditiva e idempotente**
`20261014234000_restore_rag_columns` que restaura las 4 columnas, el trigger
`chunks_tsv_update`, la función `rag_regconfig` y los 4 índices HNSW/GIN con
las definiciones exactas originales. Lección: jamás aceptar una migración
generada que elimine estas columnas; Prisma no debe gestionarlas.
