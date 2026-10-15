# 0052 — Imagen única y visibilidad en home por categoría

- Estado: aceptado.
- Fecha: 2026-10-15.

## Contexto

El home "compra por categoría" usaba un mapa estático en el frontend
(`category-images.ts`) porque el backend no guardaba imagen por categoría.
El panel admin tampoco permitía mostrar/ocultar categorías en el home.

## Decisión

- `categories` gana tres columnas aditivas (migración `20261015000000`):
  `image_url VARCHAR(2048) NULL`, `image_alt VARCHAR(200) NULL`,
  `show_in_home BOOLEAN NOT NULL DEFAULT TRUE`.
- Una sola imagen por categoría (no tabla hija como `product_images`):
  basta para el fondo de la card y evita joins/posiciones.
- `imageUrl` reusa `imageUrlSchema` (solo https, máx. 2048); `imageAlt`
  máx. 200; `null`/vacío = sin imagen (el frontend usa fallback).
- `showInHome` por defecto `true` para no ocultar nada existente.
  La API pública expone el flag y el home filtra; el resto del catálogo
  sigue viendo todas las categorías.
- `POST/PATCH /admin/categories` aceptan los tres campos; `PATCH` solo
  toca los presentes (`imageUrl: null` limpia la portada).
- El seeder adopta como dato las 7 fotos Unsplash del home actual más
  una foto de monitores (`photo-1527443224154-c4a3942d3acf`), todas con
  `showInHome: true`.

## Consecuencias

- Migración aditiva: sin `DROP` ni reescritura.
- El mapa estático del frontend queda como fallback para slugs
  desconocidos o categorías sin imagen.
