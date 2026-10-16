# 0056 — Búsqueda de documentos por título en el listado admin

- **Fecha:** 2026-10-16
- **Estado:** aceptado
- **Contexto:** `GET /admin/documents` solo filtraba por `status`/`type`. El panel necesita buscar por título (palabra o extracto).
- **Decisión:** nuevo query param opcional `q` (`trim`, 1–100 caracteres, igual que el `q` de productos en `admin.schemas.ts`) que filtra con `title contains` case-insensitive (precedente: `admin.service.ts` productos, `admin-advisor.service.ts`). Cambio aditivo: sin `q` la respuesta es idéntica a antes.
- **Alternativas descartadas:** full-text sobre el título (innecesario para subcadena simple; el full-text pesado ya vive en chunks); filtrar solo en el frontend (rompería la paginación del servidor).
- **Consecuencias:** test e2e del filtro `q` en `test/admin-documents.e2e-spec.ts`; el frontend lo consume como `q` en `AdminDocumentListQuery`.
