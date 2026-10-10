# 0034 — Deterministic compatibility engine (no LLM)

## Contexto

Fase 5 del plan: el comparador y los avisos de compatibilidad deben ser
**deterministas**. El LLM solo explica el resultado de las reglas; nunca lo
decide (AGENTS.md §5.1, §8 Fase 5). Se necesita un motor puro y testeable que
evalúe combinaciones de productos a partir de sus `specs`, más un endpoint
`POST /compatibility/check`.

## Decisión

Crear `src/modules/compatibility/` con reglas puras (funciones sin IO, sin
LLM) sobre `specs`, un servicio delgado que hidrata productos desde SQL y un
controlador público `POST /compatibility/check`.

### Reglas incluidas

| # | Regla (`rule`) | Severidad | Descripción |
|---|---|---|---|
| 1 | `cpu-socket` | error | Socket de cada CPU (`cpus.socket`) == socket de la placa (`motherboards.socket`). |
| 2 | `ram-type` | error | Tipo de cada memoria (`ram.ram_type`) == tipo de la placa (`motherboards.ram_type`). |
| 3 | `ram-capacity` | error | Suma de `ram.ram_gb` <= `motherboards.max_ram_gb`. |
| 4 | `ram-slots` | error | Suma de `ram.modules` (por defecto 1) <= `motherboards.ram_slots`. |
| 5 | `ram-speed` | warning | Si `ram.speed_mt_s` > `motherboards.max_ram_speed_mt_s`, la memoria funciona con frecuencia reducida (sigue siendo usable). |
| 6 | `storage-interface` | error | `NVME` requiere ranura M.2 (`m2_slots >= nº de NVME`); `SSD`/`HDD` requiere puerto SATA (`sata_ports >= nº de SATA`). Heurística de factor de forma: `form_factor` con `m.2`/`m2`/`nvme` cuenta como M.2; `2.5`/`3.5`/`sata` cuenta como SATA. |
| 7 | `psu-wattage` | error | `wattage_w` >= carga estimada × 1,20 (20 % de margen, ver abajo). |
| 8 | `build-single-board` | error | Más de una placa base en la misma combinación. |
| 9 | `build-single-cpu` | error | Más de una CPU en la misma combinación (equipos de consumo: una CPU por placa). |
| 10 | `build-needs-board` | warning | Hay CPU/RAM/almacenamiento pero ninguna placa: no se puede evaluar socket/RAM/almacenamiento. |
| 11 | `build-needs-psu` | warning | Hay CPU/GPU pero ninguna fuente: no se puede evaluar potencia. |
| 12 | `build-laptop-mix` | warning | Un `laptops` (equipo cerrado) mezclado con componentes sueltos no es combinable. |

Categorías fuera de alcance (`laptops` salvo regla 12, periféricos futuros sin
`specsSchema`): no generan reglas; si no hay pares evaluables, el resultado es
`compatible: true` con `issues: []`.

### Datos insuficientes → warning, nunca certeza

Si los productos relevantes existen pero faltan las claves `specs` necesarias
para evaluar una regla, se emite un `warning` con clave `*.missing-data` y
**`compatible` es `false`**. Regla global del motor:

```
compatible = issues.length === 0
```

Cualquier `warning` (dato faltante, placa/fuente ausente, mezcla con laptop)
hace `compatible: false`: sin evidencia suficiente nunca se declara
compatibilidad con certeza. Los `warning` no bloquean la compra por
incompatibilidad probada; señalan incertidumbre.

### Margen de fuente (regla `psu-wattage`)

```
estimatedW = 100 (base: placa + RAM + almacenamiento + ventilación)
           + Σ tdp_w de CPUs + Σ tdp_w de GPUs
requiredW  = ceil(estimatedW × 1,20)
```

- Base fija de **100 W** y margen del **20 %**: valores conservadores y
  documentados aquí para que el cálculo sea auditable sin consultar al LLM.
- Sin GPU en la combinación se usa solo CPU + base (los gráficos integrados
  van incluidos en el TDP de la CPU).
- Sin datos de `tdp_w`/`wattage_w` → `warning` (`psu.missing-data`), no se
  asume nada.

### Nuevos campos opcionales de placa base

`motherboards` gana tres campos **opcionales** (aditivos, sin migración: los
`specs` son JSONB libre y el seed sigue validando):

- `max_ram_speed_mt_s` (integer, MT/s)
- `m2_slots` (integer)
- `sata_ports` (integer)

El seed actual no los trae: hasta que el catálogo se enriquezca, las reglas
`ram-speed` y `storage-interface` devuelven `warning` de datos insuficientes
con productos del seed (comportamiento correcto según la regla global).

### i18n de mensajes

Cada issue lleva `rule`, `severity`, `productIds`, `messageKey` y `message`.
Los textos viven en un diccionario `es`/`en` en
`rules/messages.ts` (claro, sin jerga); `locale` del body (BCP 47, por defecto
`DEFAULT_LOCALE` con fallback a `en`) elige el idioma. Superconjunto del
contrato pedido (`messageKey` añadido, `message` intacto).

## Alternativas consideradas

- `compatible: true` con warnings presentes: rechazado — violaría "sin datos
  suficientes, nunca declarar compatible con certeza".
- Severidad `error` para exceso de velocidad RAM: rechazado — el hardware
  reduce la frecuencia y sigue funcionando; es `warning`.
- Reglas de factor de forma de caja/GPU (`length_mm` vs caja): sin categoría
  de cajas en el catálogo; no se inventa. Pendiente hasta que exista.

## Consecuencias

- Ninguna regla importa SDKs de IA ni usa LLM (verificable por lint/grep).
- Tests unitarios por regla (compatible / incompatible / datos faltantes) con
  casos del seed (SKUs reales citados en los specs de test).
- Sin cambios de BD (sin migraciones).
