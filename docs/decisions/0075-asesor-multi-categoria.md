# 0075 — Asesor multi-categoría: guidance en lugar de `unknown_category`

Fecha: 2026-10-19
Estado: aceptado

## Contexto

Reporte con captura: `tarjeta madre, procesador, memoria, disco duro y fuente de poder, todo compatible` recibía `Parece que buscas un tipo... no está en mi catálogo` en bucle. Causa: `purchaseIntent` solo admite un `categorySlug` (`intent.v1.md`: `the single most specific...`); un pedido bundle menciona 5 categorías válidas, el extractor devuelve `categorySlug=undefined`, y el gate lo trataba como categoría inexistente (ADR 0053, `reason='unknown_category'`). El mensaje era falso (esas categorías sí existen) y se repetía idéntico cada turno.

## Decisión

- Detector determinista `detectMentionedCategories()` en `intent.service.ts` (sinónimos es/en, insensible a tildes/mayúsculas, `>= 2` = multi-categoría). Sin LLM, sin costo, testeable.
- En `RecommendService`, cuando `categorySlug===undefined` y `mencionadas>=2`, responder `buildMultiCategoryMessage()`: `Puedo ayudarte con una categoría a la vez... Elige una... presupuesto máximo y uso...`, con `reason='multi_category'` en `unanswered_queries` (texto libre, sin migración).
- El caso `unknown_category` (0-1 menciones, p. ej. audífonos) no cambia (ADR 0053).

## Consecuencias

- El bundle ya no recibe un mensaje falso de "fuera de catálogo".
- El asesor sigue recomendando de a una categoría (sin cambio de esquema SQL ni de prompts LLM); el armado compatible completo queda como evolución futura.
- La guidance es estable entre turnos (mismo input → mismo mensaje), sin repreguntar en bucle.
