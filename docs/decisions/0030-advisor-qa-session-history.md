# ADR 0030 — product-QA registra turnos en la sesión de chat

Fecha: 2026-10-09 · Estado: aceptado

## Contexto

ADR 0029 creó la persistencia de sesiones pero nada las escribía: el QA de
producto (ADR 0025) respondía sin dejar rastro conversacional y
`unanswered_queries.session_id` seguía siempre NULL. Esta tarea conecta
ambos: `POST /advisor/product-qa` acepta `sessionId` opcional y registra el
turno (pregunta + respuesta con citas, o pregunta en abstenciones).

## Decisión

- **`sessionId` opcional** en el body del QA (UUID; 400 si malformado). Sin
  `sessionId` el comportamiento es idéntico al anterior (cero escrituras de
  historial; `sessionId: null` en abstenciones).
- **Verificación antes del coste**: con `sessionId` presente, el servicio
  exige propiedad (`ChatSessionsService.assertSessionOwned`, mismo 404
  indistinguible de ADR 0029) DESPUÉS del chequeo de producto ACTIVE pero
  ANTES de retrieval/LLM: un id ajeno no consume embeddings ni LLM y no deja
  filas (`unanswered_queries`, mensajes).
- **Persistencia tras el resultado**: en respuestas se anexan USER (pregunta)
  y ASSISTANT (texto + `citations` validadas, `products: []`); en
  abstenciones solo USER y la fila de `unanswered_queries` lleva el
  `sessionId`. Las citas guardadas son las ya validadas contra chunks
  entregados (nunca `[n]` inventados).
- **Límites heredados, no duplicados**: la escritura usa
  `ChatSessionsService.addMessage`, así que `ADVISOR_SESSION_MAX_MESSAGES` y
  `ADVISOR_MESSAGE_MAX_LENGTH` aplican igual que en `POST /:id/messages`. Una
  sesión llena rechaza el QA con 400 (tras la llamada al LLM ya realizada)
  para que la UI rote de sesión en vez de perder historial en silencio.
- **Propietario compartido**: `session-owner.ts` extrae `resolveSessionOwner`
  (antes método privado del controlador de sesiones) y lo usan sesiones y
  product-QA, de modo que "mi sesión" significa lo mismo en ambos. El
  controlador del QA añade `OptionalJwtAuthGuard` (los invitados también
  preguntan); el throttler `advisor` no cambia.
- **Respuesta sin cambios**: el contrato de respuesta del QA no varía (el
  cliente ya conoce el `sessionId` que envió).

## Consecuencias

- Cada turno del widget "Pregúntale al asesor" puede pasar el `sessionId` de
  la página y construir historial real sin endpoint nuevo.
- La Fase 4 reutiliza `assertSessionOwned`/`addMessage` para turnos
  conversacionales y rellenará `products` con tarjetas hidratadas desde SQL.
- Coste conocido: un turno con sesión son 2 INSERTs extra; una sesión llena
  desperdicia una llamada LLM antes del 400 (documentado, aceptado).

## Cómo revertir

Quitar `sessionId` del esquema/DTO y la llamada a `recordUserTurn` en
`AdvisorService`; las filas ya guardadas quedan como historial huérfano
válido (sin borrado en la misma tarea).
