# ADR 0031 — Extracción de intención de compra (PurchaseIntent)

Fecha: 2026-10-10 · Estado: aceptado

## Contexto

La Fase 4 (asesor conversacional) necesita convertir la conversación en
restricciones de compra estructuradas antes de consultar SQL: categoría,
presupuesto (entero en unidad menor + ISO 4217), casos de uso, specs
imprescindibles, marcas y qué información crítica falta. Restricciones de
AGENTS.md §5 aplicables: el LLM nunca calcula precio/stock (aquí: ni
siquiera recomienda productos, solo extrae), todo validado con Zod, sin SDKs
de IA fuera de `modules/ai/adapters/`, sin cambios destructivos.

## Decisión

- **Esquema `PurchaseIntent`** (`modules/advisor/intent/`):
  `{ categorySlug?, maxPrice? { amount, currency }, minPrice? { amount,
  currency }, useCases[], mustHaveSpecs, brandsInclude[], brandsExclude[],
  missingInfo[] }` con Zod. `mustHaveSpecs` acepta cualquier clave en el
  esquema y el servicio **descarta las desconocidas** (no es error: una
  alucinación degrada a menos filtros, no a un reintento). `categorySlug`
  desconocido → `undefined` + `missingInfo: ['category']`.
- **Parser determinista previo al LLM** (`budget-parser.ts`, es/en):
  "máximo 800 dólares", "under $800", "$1.5k USD", "4 millones de pesos",
  "€500", "entre 300 y 800 dólares", "desde 300 dólares" (min). Conversión
  con `toMinorUnits` (2 decimales por defecto; lista cero-decimal alineada
  con `payments/stripe-amount.ts`). "pesos" es ambiguo (COP/MXN/ARS/…) y
  **nunca** mapea a un ISO por sí solo: usa la moneda de la sesión o
  `BASE_CURRENCY`. Un número sin evidencia de moneda ni palabra de
  presupuesto cercana se ignora ("16GB RAM" jamás es presupuesto).
- **`IntentService`**: resuelve locale/moneda, parsea el presupuesto sobre
  los turnos USER, llama a `generateJson` (JSON + Zod + UNA reintento de
  corrección, sin tool-calling) con el prompt versionado
  `docs/rag/prompts/intent.v1.md` (placeholders `{{locale}}`,
  `{{baseCurrency}}`, `{{currencies}}`, `{{categories}}`, `{{specKeys}}`),
  sanea la salida, **copia el hint determinista sobre los presupuestos del
  modelo** y completa `missingInfo` (`budget`/`use`/`category`) para que el
  asesor haga UNA pregunta de aclaración (`buildClarificationQuestion`,
  prioridad budget → use → category, es/en).
- **Errores controlados**: `LlmJsonError` tras el reintento (2 llamadas) se
  propaga tipado para que el llamante pida aclaración/reintente; nunca se
  devuelve un intent inventado. Conversación vacía → intent vacío con
  `missingInfo` completo sin llamar al LLM (cero coste).
- **Sin endpoint ni persistencia** en esta tarea: el servicio queda
  registrado/exportado en `AdvisorModule` para la recomendación SQL de la
  siguiente tarea. Sin dependencias nuevas, sin migraciones.

## Consecuencias

- "portátil para programar con Docker, máximo 800 dólares" y "laptop for
  programming with Docker, under $800" convergen a `laptops` + `80000 USD`
  + uso con Docker (parser determinista + tests).
- Cambiar el modelo/proveedor es solo configuración (`LlmProvider`); el
  prompt neutro y `generateJson` funcionan con cualquiera.
- El presupuesto nunca depende del humor del modelo: el parser manda.

## Cómo revertir

Quitar `IntentService` de `AdvisorModule` y el directorio
`modules/advisor/intent/`; el prompt `intent.v1.md` queda como documento
huérfano válido (sin borrado en la misma tarea).
