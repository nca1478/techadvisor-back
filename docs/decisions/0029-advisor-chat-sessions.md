# ADR 0029 — Persistencia del historial de conversación del asesor

Fecha: 2026-10-09 · Estado: aceptado

## Contexto

La Fase 4 (asesor conversacional) necesita historial persistido: sesiones con
mensajes USER/ASSISTANT, citas y tarjetas de producto. Requisitos de la tarea:
modelos `ChatSession`/`ChatMessage`, endpoints de creación y lectura con
propiedad estricta (incluido invitado anónimo), límites de tamaño y retención
configurable con limpieza de sesiones anónimas antiguas. Restricciones de
AGENTS.md §5 aplicables: sin datos personales al LLM (aquí: ni siquiera se
almacenan deliberadamente), sin exponer datos ajenos, todo aditivo.

## Decisión

- **Modelos** (migración aditiva `20261009120000`):
  - `chat_sessions(id, user_id? FK CASCADE, anon_session_id?, created_at,
    updated_at)` con CHECK de exactamente-un-propietario (`user_id` XOR
    `anon_session_id`). `anon_session_id` es el uuid verificado del `sid` de
    invitado (ADR 0010), nunca el valor firmado del cookie.
  - `chat_messages(id, session_id FK CASCADE, role USER|ASSISTANT, content
    TEXT, citations JSONB default [], products JSONB default [], timestamps)`,
    append-only (el código solo INSERTa; índice `(session_id, created_at)`).
  - `unanswered_queries.session_id` (reservado en ADR 0025) sigue sin FK en
    esta fase; la conversación lo rellenará cuando el QA cite sesión.
- **Propiedad**: cada lectura/escritura recarga la sesión y compara
  `userId`/`anonSessionId` con el llamante. Id desconocida, sesión ajena y
  cruce usuario↔invitado devuelven el mismo 404 (no se revela propiedad). Sin
  bypass de admin: una sesión nunca es accesible por otro usuario.
- **Endpoints** (`ChatSessionsController`, base `advisor/sessions`, throttler
  `advisor` como product-qa):
  - `POST /` — crea sesión de usuario (Bearer) o anónima (emite cookie `sid`
    como el carrito); `GET /:id` — historial propio (más antiguo primero);
    `POST /:id/messages` — anexa un mensaje; `GET /` — solo autenticado, lista
    sesiones propias (más nuevas primero, con `messageCount`).
  - `POST /cleanup` — solo `ADMIN` (`JwtAuthGuard + RolesGuard`): purga
    sesiones anónimas con `created_at` anterior a
    `ADVISOR_ANON_SESSION_RETENTION_DAYS` (cascada a mensajes). Es el trigger
    del "job": un cron externo lo llama; no se añade `@nestjs/schedule` en
    esta fase para no introducir dependencia nueva.
- **Límites** (variables de entorno, sin cambios de código para ajustarlos):
  - `ADVISOR_SESSION_MAX_MESSAGES=100` — anexar por encima devuelve 400.
  - `ADVISOR_MESSAGE_MAX_LENGTH=2000` — el esquema Zod exige no-vacío y el
    servicio aplica el tope configurable (400 si se supera).
  - `ADVISOR_ANON_SESSION_RETENTION_DAYS=30` — alineado con la vida del `sid`
    (30 días, ADR 0010); las sesiones de usuario nunca se purgan.
  - Ambos 400 llevan el formato uniforme `{ statusCode, code, message }`.
- **Auth reutilizada**: `OptionalJwtAuthGuard` y helpers `sid` se importan
  del módulo `cart` (misma fuente, instancia propia registrada en
  `AdvisorModule` + `AuthSecurityModule` importado para los primitivos JWT).
  No se duplica lógica de cookies ni se toca `cart/`.
- **Privacidad**: `content` guarda solo lo que el cliente envía; el servicio
  nunca lo registra en logs (solo conteos) y no hay redacción PII deliberada
  en esta fase. La nota de privacidad en la UI queda para el frontend.

## Consecuencias

- La Fase 4 puede anexar turnos y leer historial sin tocar persistencia.
- Subir/bajar límites o retención es solo configuración.
- El `POST /cleanup` queda disponible para programarlo (cron/CICD) hasta que
  haya scheduler interno.

## Cómo revertir

Quitar `ChatSessionsController`/`ChatSessionsService` de `AdvisorModule`;
las tablas quedan sin lecturas hasta la Fase 7 (no se borran en la misma
tarea: migración separada).
