# 0035 — Advisor product comparison (`POST /advisor/compare`)

## Contexto

Fase 5 del plan: comparar 2–3 productos con datos de SQL y un resumen
redactado por el LLM, aplicando las reglas deterministas de compatibilidad
(P5.1, ADR 0034) entre los productos comparados cuando corresponda. Rigen
AGENTS.md §5.1 (el LLM nunca decide compatibilidad ni genera cifras) y §7
(prompts neutros, citas `[n]` validadas por el backend).

## Decisión

Nuevo `CompareService` en `src/modules/advisor/compare/` detrás de
`POST /advisor/compare { productIds[2..3], useCase?, locale? }`:

1. **Hidratación SQL, solo ACTIVE.** Los productos se leen de SQL con
   `status = 'ACTIVE'`, incluyendo `prices` (overrides por moneda),
   `brand`, `category` (slug para el motor de compatibilidad) y `specs`.
   Ids desconocidos o no ACTIVE → 404 idéntico (no revela borradores).
2. **Tabla comparativa generada por código** (`comparison-table.ts`, pura y
   unit-testeada): filas alineadas por clave de spec (unión de claves,
   ordenadas; `null` cuando un producto no trae la clave) más una fila de
   precio en unidades menores con su ISO 4217. La mejor por fila se destaca
   solo con criterio objetivo y valores numéricos completos:
   - `higherIsBetter`: `ram_gb`, `storage_gb`, `vram_gb`, `cores`,
     `threads`, `base_ghz`, `boost_ghz`, `boost_mhz`, `battery_wh`,
     `read_mb_s`, `write_mb_s`, `speed_mt_s`, `max_ram_gb`,
     `max_ram_speed_mt_s`, `ram_slots`, `m2_slots`, `sata_ports`,
     `screen_inches`.
   - `lowerIsBetter`: `weight_kg` y la fila de precio (solo si todos los
     productos comparten moneda; comparar unidades menores entre monedas
     distintas sería incorrecto, así que sin moneda común no hay destacado).
   - Claves de texto/enum (`socket`, `ram_type`, …) o con datos faltantes:
     sin destacado. `tdp_w` se excluye a propósito (más TDP no es
     objetivamente mejor ni peor).
3. **Compatibilidad determinista reutilizada.** El servicio hidrata la vista
   mínima del motor (`id`, `name`, `categorySlug`, `specs`) y llama al motor
   puro `checkCompatibility` de ADR 0034 directamente (sin pasar por HTTP ni
   por `CompatibilityService`, que acepta cualquier estado). El resultado
   (`compatible` + `issues`) viaja al prompt como DATO y se devuelve tal cual
   en la respuesta; el LLM solo lo explica.
4. **Resumen redactado por `LlmProvider`** con prompt versionado
   `docs/rag/prompts/compare.v1.md` (neutro, sin tool-calling): debe explicar
   diferencias relevantes para el `useCase`, sin inventar datos fuera de la
   tabla/evidencia, con citas `[n]`. Evidencia: búsqueda híbrida por producto
   + chunks generales sin producto, degradando a sin-evidencia si la
   recuperación falla (el resumen de tabla siempre se puede redactar).
5. **Validación posterior (opción más simple):** se extraen los UUIDs
   mencionados en el resumen y se comprueba que pertenezcan al conjunto
   comparado; ante un id ajeno se regenera UNA vez con corrección explícita y,
   si persiste, se usa un resumen determinista generado por código desde la
   tabla (sin LLM). La fidelidad numérica se garantiza estructuralmente: el
   prompt solo entrega las cifras de la tabla y prohíbe afirmar cualquier otra
   (mismo patrón que ADR 0025/0032); no se implementa un validador numérico
   porque los conteos en lenguaje natural ("2 productos") producirían falsos
   positivos.
6. Respuesta: `{ products[], table, compatibility, summary, citations[] }`.
   `products[]` y `table` salen íntegramente de SQL; el LLM no modifica ni
   agrega cifras.

## Alternativas consideradas

- Reutilizar `CompatibilityService.check` vía inyección: rechazado — acepta
  productos en cualquier estado y re-hidrataría desde SQL; el compare ya
  hidrata ACTIVE y necesita `categorySlug`, así que llamar al motor puro con
  esos datos evita doble consulta y deriva de estado.
- Endpoint separado `POST /advisor/compare` frente a reutilizar el chat de
  sesiones: rechazado — comparar es una operación puntual sin historial (como
  `product-qa`); no se registra en sesiones en esta tarea.
- Validación numérica exhaustiva del resumen contra la tabla: rechazado por
  falsos positivos (conteos, citas `[n]`); se documenta la garantía
  estructural por prompt + fallback determinista.

## Consecuencias

- Sin cambios de BD (sin migraciones).
- Sin imports de SDKs de IA fuera de `modules/ai/adapters/` (verificable por
  lint/grep); el motor de compatibilidad sigue sin LLM.
- Rate limit del throttler `advisor` heredado del controlador.
- Tests unitarios con LLM falso + e2e contra SQL real.
