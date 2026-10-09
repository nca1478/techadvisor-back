# 0027 — LLM vía OpenAI Responses API (opencode-go Zen + Muse Spark)

Fecha: 2026-10-09
Estado: aceptado

## Contexto

El plan opencode Go expone los modelos (incluido
`muse-spark-1.3-contributor`, de Meta) solo vía OpenAI Responses API
(`POST https://opencode.ai/zen/go/v1/responses`), no vía
`/chat/completions`. El adapter genérico `openai-compatible` no sirve:
otro formato de petición (`instructions` + `input`, `max_output_tokens`)
y de respuesta (`output[]` con items `message`/`reasoning`, deltas SSE
`response.output_text.delta`).

## Decisión

- Nuevo adapter genérico `openai-responses` (`LLM_PROVIDER=openai-responses`),
  configurable con `LLM_BASE_URL` + `LLM_MODEL` + `LLM_API_KEY`, reutilizable
  para OpenAI directo, Azure, Vercel AI Gateway u opencode-go Zen. Nada de
  código específico de opencode fuera de la configuración.
- El system prompt viaja en `instructions` (texto plano neutro, igual que
  antes); solo los items `message/output_text` forman la respuesta (los
  `reasoning` se ignoran); errores normalizados a `AiProviderError`
  (401/403→auth, 429→rate-limit, resto igual que el adapter hermano).
- Sin parámetro de esfuerzo de razonamiento: el proveedor usa su defecto.
  `max_output_tokens` cubre razonamiento + texto visible, así que con
  modelos de razonamiento conviene subir `LLM_MAX_TOKENS` (p. ej. 4096;
  el defecto 1024 puede dejar respuestas vacías si el razonamiento lo
  consume).
- Config para Muse Spark con el plan Go (ver `.env.example`):
  `LLM_PROVIDER=openai-responses`,
  `LLM_BASE_URL=https://opencode.ai/zen/go/v1`,
  `LLM_MODEL=muse-spark-1.3-contributor`, `LLM_API_KEY=<zen-api-key>`.

## Consecuencias

- Cambiar de proveedor/modelo sigue siendo solo configuración; hay test
  de factory que lo prueba sin red.
- El consumo del plan Go (cuotas/rate-limit del plan) se refleja como
  429→reintento y 503→mensaje amable, igual que otros proveedores.
- La key Zen es personal e intransferible: vive solo en `.env` local,
  nunca en código ni logs.
