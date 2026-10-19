# 0076 — Asesor con filtro de compatibilidad por anclas de sesión

Fecha: 2026-10-19
Estado: aceptado

## Contexto

Reporte con captura: el asesor recomendó 3 productos incompatibles entre sí (CPU Intel LGA1700 + placa AM5/DDR5 + RAM DDR4) y el carrito mostró 2 errores de compatibilidad. Causa: `RecommendService` filtraba por categoría, precio y specs, pero nunca por compatibilidad cruzada con lo ya recomendado en la sesión. El motor determinista ADR 0034 solo se usaba en `compare` y en `/compatibility/check` (carrito), no en la recomendación.

## Decisión

- Anclas = `productId` de tarjetas ya recomendadas en la sesión (`ASSISTANT.products`), hidratadas desde SQL (solo ACTIVE, con `categorySlug` + `specs`, tope 10).
- Tras `findCandidates`, `filterCompatibleCandidates()` excluye candidatos que den `severity: 'error'` con las anclas (`checkCompatibility`, locale resuelto). Los `warning` (datos faltantes) nunca excluyen.
- Si todo se excluye y hay anclas, respuesta determinista `incompatible_anchors` (sin LLM) + `unanswered_queries.reason='incompatible_anchors'`; si no hay anclas, flujo intacto.
- Sin cambios de contrato: no hay nuevos inputs; el LLM solo elige dentro del conjunto ya filtrado.

## Consecuencias

- Un Intel LGA1700 jamás se recomienda junto a una placa AM5 en la misma sesión; ídem DDR4 vs placa DDR5.
- Si el usuario cambia de plataforma, debe abrir nueva conversación (mensaje lo indica).
- Laptops + componentes siguen dando `warning` (no excluye), como el motor define.
