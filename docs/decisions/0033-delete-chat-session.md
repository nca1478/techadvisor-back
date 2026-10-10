# 0033 — Borrado físico de sesiones de chat del asesor

Fecha: 2026-10-10
Estado: aceptado

## Contexto

El frontend añade historial de conversaciones (ADR 0028 del frontend) pero la
API no ofrecía borrado: una sesión solo desaparecía por la purga de anónimas
o quedaba huérfana en el navegador. Se pide eliminar físicamente una
conversación guardada desde la UI.

## Decisión

- Nuevo `DELETE /advisor/sessions/:id` → `204` (sin cuerpo), con la misma
  semántica de propiedad que el resto del módulo: el `owner` (usuario Bearer o
  `sid` invitado) se re-verifica en `ChatSessionsService.deleteSession` y los
  ids desconocidos o ajenos devuelven `404` idéntico (sin revelar propiedad).
  El `id` se valida con el `chatSessionParamsSchema` existente (`400` si no
  es UUID).
- Borrado físico real: `prisma.chatSession.delete`; los mensajes caen en
  cascada (`ChatMessage.session`, `onDelete: Cascade`). Sin migración: el
  esquema ya lo soporta.
- `UnansweredQuery.sessionId` es un campo plano sin FK: esas filas de
  analítica (append-only, Fase 7) se conservan con el id huérfano a
  propósito; el borrado solo elimina sesión + mensajes.
- Tests: unitarios (dueño borra user/guest; ajenos/unknown 404 sin tocar BD)
  y e2e (204, cascada verificada por conteo, listado sin el id, invitado
  borra la suya, `400`/`404`).

## Consecuencias

- El frontend puede ofrecer "eliminar" con un `DELETE` al BFF; tras el `204`
  la sesión es irrecuperable (diseño: borrado físico, no papelera).
- Sin cambios de contrato salvo el endpoint nuevo (OpenAPI lo publica solo).

## Cómo revertir

Quitar el `@Delete(':id')` del controlador y `deleteSession` del servicio: la
UI vuelve a depender solo de la purga por retención.
