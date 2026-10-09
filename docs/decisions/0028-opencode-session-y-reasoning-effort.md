# 0028 — opencode-go Zen exige `x-opencode-session` + effort de razonamiento

Fecha: 2026-10-09
Estado: aceptado
Suplementa: 0027

## Contexto

Con el adapter 0027, Zen respondía 400 `inference_failed` sin intentar
el modelo (`attemptCount: 0`). Reproducción mínima mostró el motivo
real: `MissingSessionID` — el gateway exige el header
`x-opencode-session` (id estable por conversación) para rutear y
cachear el prompt (ver https://opencode.ai/docs/go/#where-can-i-use-it).
Además, con el header puesto el modelo respondió 200 pero con
`output: []` y `status: incomplete` (motivo `max_output_tokens`):
su esfuerzo de razonamiento por defecto es `high` y consumió todo el
presupuesto (253/256 tokens) sin dejar texto visible.

## Decisión

- El adapter envía siempre `x-opencode-session`: un UUID generado por
  instancia (estable durante la vida del proceso → afinidad de ruteo
  y caché del system prompt, que es estable). Sin env nueva, sin datos
  personales. Ignorado sin daño por proveedores que no lo usan.
- Nueva env opcional `LLM_REASONING_EFFORT=minimal|low|medium|high`:
  se envía como `reasoning.effort` solo cuando está definida (los
  modelos sin razonamiento rechazan el parámetro). Para el asesor con
  Muse Spark: `minimal` + `LLM_MAX_TOKENS=4096`.
- Sin cambios de contrato ni de lógica de negocio.

## Consecuencias

- Operativa con Go: `LLM_PROVIDER=openai-responses`,
  `LLM_BASE_URL=https://opencode.ai/zen/go/v1`,
  `LLM_MODEL=muse-spark-1.3-contributor`, `LLM_API_KEY=<zen-key>`,
  `LLM_REASONING_EFFORT=minimal`, `LLM_MAX_TOKENS=4096`, reiniciar la API.
- Nota de uso: el plan Go está diseñado para coding agents; nuestro
  Q&A es tráfico pequeño y con forma estándar (Responses + sesión),
  pero si opencode alguna vez lo limitara, cambiar de proveedor sigue
  siendo solo configuración (diseño agnóstico).
