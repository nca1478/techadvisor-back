# 0040 — Panel admin del ciclo de mejora del asesor

Fecha: 2026-10-10
Estado: aceptado

## Contexto

P7.3 cierra el ciclo de mejora continua: un admin debe ver las consultas sin
respuesta más frecuentes, marcarlas como resueltas (tras crear el documento
que cubre el hueco), revisar el feedback 👍/👎 y consultar métricas
(abstención, satisfacción, consultas frecuentes). Restricciones: solo ADMIN,
retención y minimización de datos (las sesiones de chat son privadas por
diseño y el cleanup de anónimas las purga, ADR 0029; `ai_call_logs` nunca
guarda contenido, ADR 0039).

## Decisión

- `UnansweredQuery.status` (`NEW` | `IN_REVIEW` | `RESOLVED`, migración
  aditiva `20261012000000_add_unanswered_status`, defecto `NEW` + índice).
  Transición solo hacia adelante, validada en el servicio (`RESOLVED` es
  terminal): reabrir se rechaza con 400 para que el loop no regrese en
  silencio. Solo se actualiza `status`; la pregunta registrada es inmutable.
- Agrupación por similitud simple en `query-normalize.ts`: minúsculas,
  plegado de diacríticos, sin puntuación, espacios colapsados. Heurística de
  triaje, no afirmación semántica: las filas individuales siguen listadas en
  `GET /unanswered`. El escaneo está acotado (`scanLimit`, máx. 2000) para no
  recorrer la tabla entera.
- Endpoints `GET /api/v1/admin/advisor/*` (JwtAuthGuard + `@Roles('ADMIN')`,
  paginados `page/limit` como el resto del admin): `unanswered`,
  `unanswered/groups`, `feedback`, `feedback/:id`, `sessions/:id`, `metrics`.
  `PATCH unanswered/:id` mueve el triaje.
- Minimización: los listados de feedback llevan extractos (pregunta 200,
  respuesta 300) con longitudes totales; el texto completo vive solo en el
  detalle explícito. El enlace a conversación (`sessions/:id`) devuelve rol,
  fecha y extracto de 200 caracteres por mensaje — nunca el contenido
  completo; sesiones purgadas o desconocidas dan el mismo 404.
- Votos con sesión: `AdvisorFeedback.sessionId` (migración aditiva
  `20261012010000_feedback_session_id`, columna plana sin FK como en
  `UnansweredQuery`) guarda la sesión de la respuesta votada cuando la
  superficie la conoce (el widget de producto la envía); el panel enlaza el
  voto con su conversación minimizada.
- Métricas (`metrics`): abstenciones abiertas por estado/motivo, votos
  up/down con tasa de satisfacción (`null` sin votos) y top-10 de preguntas
  abiertas normalizadas por frecuencia. Solo conteos y extractos ya visibles
  en el panel; nada llega a logs salvo depuración de conteos.
- "Crear documento a partir de esto": el panel enlaza a
  `/admin/documentos?title=<pregunta>` que pre-rellena el título del
  formulario de alta; el documento resultante se ingiere por el pipeline
  existente y la consulta se marca `RESOLVED`.

## Consecuencias

- El frontend regenera tipos con `npm run api:types` (nuevos DTO en el
  contrato OpenAPI).
- Cambiar la normalización no toca persistencia: es cómputo en memoria sobre
  el texto registrado.
- Si el volumen de abstenciones crece, `scanLimit` y el top-10 de métricas
  mantienen las respuestas acotadas; una agregación SQL por clave
  normalizada queda como mejora futura documentada aquí.
