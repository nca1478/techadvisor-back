# 0047 — Seed bilingüe: nombres, descripciones y slugs en inglés + ES

Fecha: 2026-10-14
Estado: aceptado

## Contexto

El seed del catálogo SpeedLogic (ADR 0046) tenía `name`/`description`/`slug`
en español en ambas columnas (`DEFAULT_LOCALE=en` exige inglés en las
columnas base y español en `*_es` / `product_translations`).

## Decisión

- Columnas base (`name`, `description`, `slug`) en **inglés** para los 273
  productos; `nameEs`/`descriptionEs` conservan el texto original español
  byte por byte (traducciones `es` reales, no marcadores).
- Traducción determinista y offline con scripts versionados fuera del repo
  (`Temp\opencode\tr_names.cjs`, `tr_desc_sent.cjs`, `tr_desc.cjs`):
  - Nombres: reglas por categoría (sustantivo al final — *Graphics Card*,
    *Laptop*, *RAM Memory*, *LED Monitor*, *Motherboard*, *Power Supply*,
    *Processor*, *Solid State Drive* / *Hard Drive*), preservando marcas,
    modelos y specs (`RTX-4060`, `A520m-K`, `8700G` intactos), Title Case con
    diccionario de siglas y normalización de unidades (`Gigas→GB`,
    `Pulgadas→inch`, `3,2→3.2`, `80p→80+`, `XII→12th`).
  - Descripciones: 70 frases frecuentes traducidas a mano + glosario de
    ~330 frases y ~330 palabras en una sola pasada izquierda-derecha (sin
    re-escaneo, con respeto a mayúsculas y entidades HTML como `&#x2122;`).
  - Slugs regenerados del nombre inglés + el mismo sufijo numérico
    (`...-graphics-card-29653`); unicidad y formato intactos.
- Calidad medida: 0 slugs duplicados/inválidos, nombre EN más largo 154/200,
  descripción EN más larga 1226/5000, residuos de español solo en
  frecuencia ≤2 por producto salvo `reduce` (inglés correcto de *reducen*).

## Consecuencias

- El seed sigue idempotente (upsert por `sku`; el slug se actualiza en la
  fila existente, sin duplicados). Precios, stock, marcas, categorías,
  specs e imágenes no cambian.
- Limitación conocida: el inglés de las descripciones es "de plantilla"
  (orden adjetivo-sustantivo ocasionalmente invertido, p. ej. *details
  vibrant*); suficiente para demo/RAG, mejorable con revisión humana o MT
  neuronal en el futuro sin cambiar el procedimiento.
