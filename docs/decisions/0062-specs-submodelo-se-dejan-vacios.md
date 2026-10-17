# 0062 — Specs dependientes de submodelo se dejan vacíos (no adivinar)

- Estado: aceptado
- Fecha: 2026-10-17
- Repo afectado: `backend`

## Contexto

Barrido exhaustivo de los 273 productos del seed contra
`SPECS_FIELDS_BY_CATEGORY`: 265/273 completos. Quedan 12 celdas
vacías en 8 productos, todas verificadas como no-resolubles sin el
submodelo/MTM exacto:

- `laptops.battery_wh`: SL-52348, SL-52387 (LOQ: 60 u 80 Wh según
  configuración, PSREF), SL-52388 (50 o 60 Wh), SL-52392 (42, 50 o
  70 Wh según región).
- `laptops.weight_kg`: SL-52381 (1.5 kg IPS / 1.38 kg OLED),
  SL-52388 (1.59 / 1.63 / 1.49 kg según batería+panel).
- `storage.read_mb_s` / `write_mb_s`: SL-7078, SL-7079 (Skyhawk HDD:
  Seagate no publica tasa sostenida por modelo en ficha accesible),
  SL-9004 (Toshiba Canvio: solo publica interfaz USB, no tasa de disco).

## Decisión

Dejar esas celdas vacías en vez de cargar el valor de "una"
configuración. Cargar un valor plausible pero no verificado violaría
la restricción 1 de `AGENTS.md` (el LLM y el catálogo nunca inventan
specs numéricas). Ninguna de esas celdas la consume el motor de
compatibilidad (`rules.ts` usa `storage_type`/`form_factor`,
no velocidades; ni peso ni batería), así que no generan warnings
espurios: las reglas solo advierten `missing-data` sobre datos que
sí necesitan.

Redondeo aplicado donde la ficha da decimales: `battery_wh` es
entero (52.4→52, 53.5→54, 55.2→55, 46.8→47).

## Consecuencias

- El comparador muestra "—" en esas celdas (comportamiento ya
  existente de `formatCompareCell`), sin highlights falsos.
- Si aparece la ficha del submodelo exacto, el valor se carga en
  `products.json` y el hash de la SPEC_SHEET re-ingiere solo esa ficha.
- Sin migración de BD, sin dependencias nuevas.
