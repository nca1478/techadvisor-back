# 0039 — Observabilidad operativa del asesor y la ingesta

Fecha: 2026-10-10
Estado: aceptado

## Contexto

La tarea exige visibilidad operativa del asesor y la ingesta: latencia y tasa
de error por proveedor y modelo, abstenciones, colas BullMQ, documentos por
estado y healthcheck ampliado — sin guardar nunca PII ni contenido de usuario
en logs ni métricas.

## Decisión

- Tabla `ai_call_logs` (migración aditiva): `type` (EMBEDDING|LLM|RETRIEVAL),
  `provider`, `model`, `latency_ms`, `tokens_in/out` (cuando el proveedor los
  reporta), `estimated_cost` (Float USD solo telemetría, desde tarifas
  opcionales por env, NULL si no hay tarifa), `status` (OK|ERROR),
  `error_code`, `session_id?`, timestamps. Sin ninguna columna de contenido
  por diseño: es imposible persistir prompts/respuestas aunque se quiera.
- Instrumentación centralizada sin bloquear la respuesta: `AiCallLoggerService`
  (`void` + `setImmediate`, nunca `await` en el camino crítico) más dos
  decoradores `LoggingEmbeddingProvider` / `LoggingLlmProvider` creados en
  `AiModule` alrededor del adapter configurado, y un tramo cronometrado en
  `RetrievalService` (tipo RETRIEVAL, proveedor `local`). Los errores se
  normalizan a `AiErrorCode` (o nombre de clase) sin mensajes con contenido.
- Sin dependencias nuevas: el endpoint `GET /api/v1/metrics` (solo ADMIN,
  `JwtAuthGuard + RolesGuard`) expone formato texto Prometheus construido a
  mano (latencia media, totales por proveedor/modelo/estado, abstenciones por
  `reason`, documentos por `status`, tamaños de colas BullMQ). Alternativa
  descartada: `prom-client` (nueva dependencia para lo que son ~40 líneas).
- Healthcheck ampliado sin llamar al proveedor: `GET /api/v1/health` suma
  `redis` (ping ioredis con timeout), `ingestion` (conteos BullMQ, `down`
  cuando Redis cae) y `ai` (último estado conocido en memoria del logger).
  La BD sigue siendo la única sonda con query real.
- Retención configurable `AI_CALL_LOG_RETENTION_DAYS` (defecto 90) con trigger
  admin `POST /api/v1/metrics/cleanup` (mismo patrón que el cleanup de
  sesiones anónimas, ADR 0029: lo llama un cron externo; sin scheduler
  interno ni librerías nuevas).
- Coste estimado: `tokens/1000 * tarifa`; `AI_COST_*_PER_1K=0` (defecto)
  significa sin tarifa y guarda NULL. Es telemetría aproximada, nunca
  facturación (por eso Float es aceptable aquí; el dinero contable sigue
  siendo entero en unidad menor, ADR 0007).

## Consecuencias

- Cambiar de proveedor/modelo no toca instrumentación: los decoradores leen
  `providerName`/`model` del adapter envuelto.
- `GET /health` cambia de forma (campos nuevos); el test e2e se actualiza a
  `toMatchObject`.
- Los tests assert que ninguna fila de `ai_call_logs` ni línea de `/metrics`
  contiene texto de pregunta/respuesta.
