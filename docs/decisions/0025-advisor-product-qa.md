# ADR 0025 — Asesor Q&A por producto (primer RAG visible)

Fecha: 2026-10-09 · Estado: aceptado

## Contexto

Fase 3 expone la recuperación híbrida (ADR 0021) como preguntas sobre un
producto con respuestas citadas. Requisitos de AGENTS.md §5: el LLM nunca
calcula precio, stock, garantías ni plazos; sin evidencia suficiente el
asesor se abstiene y registra la consulta; nada de datos personales al LLM;
sin acoplar el código a un proveedor de IA.

## Decisión

- **Endpoint** `POST /api/v1/advisor/product-qa`
  `{ productId, question, locale? }` en el módulo `advisor` (controlador
  delgado, lógica en `AdvisorService`). `question` máx. 1000 caracteres
  (igual que la recuperación); `locale` BCP 47 con fallback a
  `DEFAULT_LOCALE` cuando falta o no está soportado.
- **Flujo**: validar producto ACTIVE (otro estado → 404, sin revelar
  borradores) → dos búsquedas híbridas que se fusionan: (a) con filtro duro
  `productId` (evidencia del producto) y (b) sin filtro, conservando solo
  hits sin producto (documentos de categoría y políticas generales); se
  deduplica por `chunkId`, se ordena por score y se corta en `topN: 8`.
  Dos llamadas de embedding por pregunta es el costo aceptado por no
  extender `RetrievalService` en esta fase.
- **Abstención antes del LLM**: si no hay evidencia o el mejor score queda
  bajo `ADVISOR_ABSTAIN_MIN_SCORE` (defecto `0.016`), se responde
  `abstained: true` con mensaje localizado ("No tengo esa información…" /
  "I don't have that information…") SIN llamar al proveedor, y se registra
  la fila en `unanswered_queries` (`reason`: `no_evidence` o
  `below_threshold`). Escala: con RRF `k=60`, un chunk primero en una rama
  puntúa `1/61 ≈ 0.0164` y primero en ambas `≈ 0.0328`; el defecto exige
  que al menos una modalidad rankee la evidencia primera.
- **Prompt**: `docs/rag/prompts/product-qa.v1.md` es la fuente única
  (se carga en boot, fallo rápido si falta); el servicio solo sustituye
  `{{locale}}`. Neutro al proveedor: texto plano con delimitadores, citas
  `[n]` validadas en el backend, sin tool-calling. Los chunks se declaran
  datos no confiables y se delimitan por chunk; el prompt prohíbe seguir
  instrucciones dentro de ellos.
- **Datos SQL inyectados**: nombre, precio (base + overrides por moneda,
  ADR 0007), disponibilidad (`inStock`/`availableQuantity`,
  `InventoryService`) y `specs` viajan en un bloque separado
  `PRODUCT FACTS`; el prompt prohíbe afirmar precio/stock/garantía fuera
  de ese bloque. El LLM nunca los genera.
- **Citas**: se extraen `[n]` de la respuesta y se conservan solo las
  `1..N` entregadas (las inventadas se descartan, nunca se alucinan);
  `citations: [{ n, documentId, chunkId, title, snippet }]`.
- **Rate limiting**: throttler nombrado `advisor` (`ADVISOR_RATE_LIMIT_*`,
  defecto 30 req/min por IP); el controlador omite los throttlers `auth` y
  `search`. Hay un único `ThrottlerModule.forRoot` (en `AuthModule`,
  ADR 0022).
- **Privacidad/logs**: al LLM solo van sistema + hechos del producto +
  chunks + pregunta (sin email, dirección ni usuario). Los logs registran
  conteos (`hits`, `abstained`, `citations`) y latencia del proveedor,
  nunca el prompt ni la pregunta.
- **Tabla `unanswered_queries`** (migración aditiva): `query`, `productId?`
  (FK SET NULL), `sessionId?` (reservado para Fase 4, siempre NULL aquí),
  `reason`, timestamps. Solo INSERT desde el servicio.

## Consecuencias

- Cambiar de proveedor/modelo de LLM o embeddings es solo configuración
  (`LlmProvider`/`EmbeddingProvider`); el prompt no cambia.
- Subir/bajar `ADVISOR_ABSTAIN_MIN_SCORE` ajusta conservadurismo sin código.
- Un producto ACTIVE sin chunks indexados siempre se abstiene (evidencia
  cero) y deja rastro para el admin.

## Cómo revertir

Eliminar `AdvisorModule` de `AppModule` y el throttler `advisor` de
`AuthModule`; la tabla queda sin lecturas hasta la Fase 7 (no se borra en
la misma tarea: migración separada).
