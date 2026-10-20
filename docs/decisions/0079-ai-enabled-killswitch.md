# 0079 — Kill-switch de IA para el storefront (AI_ENABLED)

Fecha: 2026-10-20
Estado: aceptado

## Contexto
Se pide poder desactivar la IA por variable de entorno, bloqueando el
asesor de compras (widget y página), el asesor de soporte, el comparador y
el asesor en detalle de producto, sin tocar el panel admin salvo petición
explícita.

## Decisión
- Nueva variable `AI_ENABLED=true|false` (default `true`), validada en
  `src/config/env.schema.ts` con el mismo preproceso booleano que
  `DOCS_ENABLED`. Documentada en `.env.example`.
- `GET /api/v1/config/public` expone `aiEnabled`; el frontend esconde la UI
  desde ahí (fuente de verdad = backend).
- Nuevo `AiEnabledGuard` en `modules/advisor/`: con `AI_ENABLED=false`,
  la superficie pública del asesor responde `403 FORBIDDEN`
  (`AI features are disabled`) sin llamar a retrieval ni LLM.
- Alcance bloqueado: `POST /advisor/product-qa|compare|support|feedback` y
  `POST|GET|DELETE /advisor/sessions*` salvo `POST /advisor/sessions/cleanup`
  (trigger admin). No se bloquea: `GET /search`,
  `POST /compatibility/check` (determinista SQL), catálogo, reseñas ni
  `admin/*`.
- Se reutiliza el código uniforme `FORBIDDEN` (sin nuevo `ErrorCode`) para no
  romper el contrato OpenAPI; el mensaje distingue el motivo y el frontend
  mapea `403` a su aviso i18n cuando `aiEnabled=false`.

## Alternativas consideradas
- Nuevo `ErrorCode.AI_DISABLED`: más expresivo, pero cambia el contrato y
  obliga a regenerar tipos en el frontend. Se descarta por simplicidad.
- Bloquear también el admin: descartado por requisito explícito.

## Consecuencias
- Con `AI_ENABLED=false` no hay coste de embeddings/LLM desde el storefront.
- El comparador se oculta por completo en el frontend (decisión de producto),
  aunque su tabla SQL seguiría disponible por API.
