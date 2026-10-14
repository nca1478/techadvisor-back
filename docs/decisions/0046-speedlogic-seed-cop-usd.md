# 0046 — Seed con catálogo real de SpeedLogic (COP→USD, 8 categorías)

Fecha: 2026-10-14
Estado: aceptado

## Contexto

El seed de desarrollo usaba ~40 productos ficticios con imágenes
placeholder. Se pidió reemplazarlo por productos reales de
https://speedlogic.com.co/ (nombre, precio, specs, imágenes) en 8
categorías: tarjetas gráficas, portátiles, RAM, monitores, placas base,
fuentes, procesadores y almacenamiento; precios convertidos de COP a USD,
stocks al azar, todos ACTIVE.

## Decisión

- Fuente: API pública de WooCommerce del sitio
  (`/wp-json/wc/store/v1/products`), solo lectura, con `User-Agent`
  identificativo y pausas entre páginas. 280 productos únicos → 273 tras
  excluir accesorios (soportes/brackets) y 1 fila sin marca atribuible.
- Conversión COP→USD con la TRM oficial vigente al 2026-10-13:
  **1 USD = 3.194,44 COP** (Superintendencia Financiera). Fórmula:
  `priceAmount = round(COP / 3194.44 * 100)` (centavos USD, entero, nunca
  float). Ejemplo: $349.000 COP → 10926 ($109,26).
- Categorías internas: `gpus`, `laptops`, `ram`, `monitors` (nueva),
  `motherboards`, `psus`, `cpus`, `storage`. `monitors` recibe tabla de
  specs propia (`screen_inches`, `resolution`, `panel_type`, `refresh_hz`)
  en `spec-fields.ts`; el resto usa las tablas existentes (todos los
  campos son opcionales, así que specs parciales extraídos del título
  pasan `parseSpecs`).
- Marcas: 25 (las 10 existentes + 15 detectadas en el catálogo: lg, acer,
  adata, patriot, crucial, xpg, antec, toshiba, lexar, aoc, xiaomi,
  western-digital, seagate, teamgroup, cougar). `seasonic` se conserva sin
  productos por compatibilidad. El tope del test de fixtures sube de 10 a
  30 marcas.
- Imágenes: URLs https remotas del sitio (hotlink, 1–3 por producto), sin
  copiar archivos. Excepción puntual a la regla "sin material con
  copyright" de P1.8, aprobada para este seed de desarrollo; en producción
  se usarían assets propios.
- Stock pseudo-aleatorio determinista (idempotencia del seed): derivado
  del hash del SKU (8–25 unidades) y 1 de cada 15 productos en 0 para
  conservar cobertura de agotados en el test.
- SKUs `SL-<id-origen>` y slugs `<nombre>-<id>` garantizan unicidad entre
  re-ejecuciones (upsert por `sku`).

## Consecuencias

- `products.json` pasa de ~40 a 273 productos; el seed sigue idempotente
  (`npm run seed` dos veces deja el mismo conteo).
- `GET /catalog/categories` expone `specsSchema` de `monitors` para el
  frontend (comparativas/formularios sin duplicar esquema).
- Los scripts de scraping/transformación viven fuera del repo
  (`Temp\opencode\scrape.cjs`, `transform.cjs`); el repo solo versiona el
  resultado + este ADR.
