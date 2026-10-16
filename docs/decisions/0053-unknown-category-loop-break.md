# 0053 — Ruptura del ciclo de aclaración por categoría desconocida

Fecha: 2026-10-16
Estado: aceptado

## Contexto

El asesor de compras entraba en bucle ante "busco audífonos": respondía
siempre "¿Qué tipo de producto buscas (portátil, procesador, memoria, …)?".
Causa: el catálogo solo tiene 8 categorías (`laptops`, `cpus`,
`motherboards`, `ram`, `gpus`, `storage`, `psus`, `monitors`) y el extractor
solo puede devolver esas (`sanitizeIntent` descarta el resto). Una categoría
inexistente no se resuelve nunca, `completeMissingInfo` re-añade `category`
y el gate de `RecommendService` preguntaba lo mismo cada turno.

## Decisión

- La pregunta de categoría se hace una sola vez por sesión. Si el turno
  siguiente sigue sin categoría resoluble (el historial ya contiene la
  pregunta exacta, detectada con `isCategoryClarification` en ambos idiomas),
  se responde terminalmente con `buildUnknownCategoryMessage`: nombra las
  categorías cubiertas e invita a elegir una, sin volver a preguntar.
- La respuesta terminal registra `unanswered_queries` con
  `reason = 'unknown_category'` (aditiva, sin migración: `reason` es texto
  libre) y guarda el turno ASSISTANT, como el resto de abstenciones.
- El gate de presupuesto no cambia (fuera del reporte).

## Consecuencias

- Sesiones posteriores sin categoría reciben la misma respuesta terminal
  (estable, sin bucle) hasta que el usuario mencione una categoría válida.
- Añadir audio/periféricos al catálogo queda como evolución futura: requeriría
  categoría + specs + seed + reindex, fuera del alcance de este fix.
