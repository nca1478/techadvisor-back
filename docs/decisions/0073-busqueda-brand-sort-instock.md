# 0073 — Búsqueda: filtros brand, sort e inStock

Date: 2026-10-19
Status: accepted

## Context

La pantalla "Buscar" solo filtraba por categoría y precio máximo, mientras el
listado de productos ofrece marca, orden y "solo en stock". Se pide paridad.

## Decisiones

1. Nuevos query params opcionales en `GET /search`: `brand` (slug, misma
   validación que catálogo), `sort` (mismos 5 valores del catálogo, sin
   default: sin `sort` se conserva el orden por relevancia) e `inStock`
   (`1`/`true` = solo en stock, misma convención que `?inStock=1` del
   listado; `0`/`false`/ausente = sin filtro).
2. `brand` filtra por `brand.slug` post-hidratación (igual que `category`);
   en modo browse va al `where` de Prisma. `inStock` usa el mapa de
   disponibilidad ya hidratado (`toAvailability(...).inStock`). `sort`
   reordena en memoria (precio resuelto por moneda, nombre, `createdAt`)
   con desempate por `id`; el browse antes cortaba en `limit` por orden
   SQL y ahora colecciona, ordena y recorta (mismo resultado sin `sort`).
3. Sin cambios destructivos en BD. Sin dependencias nuevas.

## Consecuencias

- El contrato OpenAPI de `/search` gana tres params opcionales; la
  respuesta no cambia, así que el frontend no necesita regenerar tipos
  para este cambio (solo documenta el contrato).
