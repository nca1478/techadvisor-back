# 0065 — Redis gestionado Upstash (rediss con TLS)

- Estado: aceptado.
- Fecha: 2026-10-18.
- Contexto: el backend usaba solo `redis://localhost:6379` local y `parseRedisConnection()` rechazaba cualquier otro esquema, sin auth ni TLS. Se quiere usar la instancia Upstash `techadvisor-db` (`meet-orca-68958.upstash.io`, plan free, región global/us-east-1) para colas BullMQ `ingestion` y `reindex` más sondas de salud/métricas.
- Decisión: soportar `redis://` y `rediss://` en `REDIS_URL`. `parseRedisConnection()` extrae `host`, `port`, `username`, `password`, `db` y añade `tls: {}` cuando el esquema es `rediss:`. Los clientes `ioredis` directos (`HealthService.checkRedis`) ya aceptan la URL completa, así que solo la creación de colas BullMQ necesitaba el objeto de conexión ampliado. `.env.example` documenta el formato `rediss://default:<password>@<endpoint>.upstash.io:6379`.
- Alternativas: mantener Redis solo local via docker-compose (descartado: se pidió nube); usar REST de Upstash en vez de RESP (descartado: BullMQ necesita protocolo Redis con conexión persistente).
- Consecuencias: API, workers y sondas funcionan contra local y Upstash sin cambios de código según env. La contraseña vive solo en `.env` (gitignored); `.env.example` no guarda secretos. TLS es obligatorio para `rediss://`.
