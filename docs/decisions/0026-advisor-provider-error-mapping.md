# 0026 — Errores del proveedor LLM como 429/503 uniformes en advisor

Fecha: 2026-10-09
Estado: aceptado

## Contexto

`POST /advisor/product-qa` dejaba escapar `AiProviderError` (p. ej. `auth`
cuando Anthropic responde 401 con una API key inválida) hasta el filtro
global, que lo convertía en 500 `INTERNAL_ERROR` genérico ("Unhandled
exception"). El frontend solo podía mostrar "El asesor no pudo responder",
indistinguible de un bug propio. Verificado en local: la key configurada
en `LLM_API_KEY` es rechazada por Anthropic (401 directo a `/v1/models`).

## Decisión

- `AdvisorService` envuelve solo la llamada a `LlmProvider.generate`:
  - `AiRateLimitError` → 429 `TOO_MANY_REQUESTS`.
  - Cualquier otro `AiProviderError` (`auth`, `server`, `network`,
    `timeout`, `bad_request`, `config`) → 503 `SERVICE_UNAVAILABLE`.
  - Errores que no son del proveedor se relanzan (siguen siendo 500:
    son bugs, no caídas externas).
- Mensajes genéricos al cliente ("Advisor provider unavailable, try again
  later"); solo `provider` + `code` van al log, nunca prompts ni keys.
- Sin cambios de contrato: 429/503 ya existen en `ErrorCode` y el filtro
  global los serializa al formato uniforme. El frontend ya mapea 503 a su
  mensaje amable de "servicio no disponible".

## Consecuencias

- Con la key actual (inválida), el widget muestra el mensaje de proveedor
  caído en vez del error genérico. Para respuestas reales hay que rotar
  `LLM_API_KEY` en el `.env` del backend y reiniciar la API; además
  conviene verificar que `LLM_MODEL` sea un id de modelo válido (con 401
  Anthropic no llega a validar el modelo).
