# Evaluación del RAG (Fase 7)

Medición repetible de la calidad del asesor, comparable entre modelos con el
mismo dataset. Decisión de diseño: ADR `0038-rag-evaluation-harness.md`.

## Ejecutar

```bash
npm run eval -- --offline            # CI: adapters fake, sin red ni BD
npm run eval -- --strict             # falla (exit 1) si no pasa umbrales
npm run eval -- --thresholds ./mi-eval-thresholds.json --strict  # gates alternativos (experimentos locales, no CI)
npm run eval -- --llm-provider openai-compatible --llm-model <id> \
  --embedding-provider openai-compatible --embedding-model <id> \
  --embedding-base-url ...           # comparación real entre modelos
```

Cambiar de modelo **solo** requiere flags o variables (`LLM_PROVIDER`,
`LLM_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, ...): el runner crea los
adapters con las `AiProviderFactory` reales. `--offline` fuerza los fakes
aunque el entorno configure proveedores reales.

El dataset vive en `eval/qa.jsonl` (54 casos: 27 `es` + 27 `en`; tipos
`answerable | unanswerable | adversarial | compatibility | recommendation`).
Los reportes se escriben en `eval/results/<fecha>-<llm>__<embeddings>.json`
+ `.md` (generados, no versionados).

## Cómo funciona

1. Cada caso aporta sus chunks (`corpus`) a un corpus compartido: el resto de
   casos actúa como distractores realistas.
2. Retrieval híbrido: rama vectorial (coseno sobre el `EmbeddingProvider`
   configurado) + rama léxica (overlap de tokens, equivale a la rama
   `tsvector` que en producción usa PostgreSQL), fusionadas con el
   `fuseRankings` (RRF) de producción.
3. Puerta de abstención como `AdvisorService`: sin evidencia léxica no se
   llama al LLM. Offline el "LLM" es `FakeLlmAdapter` con respuestas
   compuestas **solo** desde los chunks recuperados (nunca desde la pregunta,
   para que la inyección de los casos `adversarial` no cuele); online se usa
   el proveedor real con el mismo prompt neutro.
4. Reglas deterministas en código (veredicto de compatibilidad, filtro de
   presupuesto/stock en recomendación): el LLM solo redacta, igual que en
   producción. Precios y stock nunca salen de chunks.

## Métricas

| Métrica | Qué mide | Agregado sobre |
|---|---|---|
| `recallAtK` (k=5) | fracción de `expectedChunkIds` en el top-k | casos con chunks esperados |
| `mrr` | 1/rango del primer chunk esperado | idem |
| `abstentionAccuracy` | `abstained === expectAbstention` | todos |
| `citationValidityRate` | todo `[n]` resuelve a un chunk entregado (+ ≥1 cita si se exige) | todos |
| `hallucinationRate` | precios inventados o ids filtrados en prosa (**debe ser 0**) | todos |
| `factCoverage` | `mustContain` presentes en la respuesta | casos no abstenidos |
| `latencyP50Ms / P95Ms` | ms por caso (retrieval + generación) | todos |

Umbrales (`--strict`, desde `eval/thresholds.json`): recall@5 ≥ 90%,
abstención ≥ 80%, citas ≥ 80%, alucinación ≤ 0.

Notas de interpretación:

- Un precio mencionado en la **pregunta** (p. ej. "máximo 800 USD") no cuenta
  como alucinación si la respuesta lo repite; solo lo nuevo es invención.
- `recall`/`mrr` excluyen casos sin `expectedChunkIds` (abstención y la
  mayoría de recomendación): su evidencia es el catálogo, no los chunks.
- Offline las métricas de generación son ~perfectas por construcción (el fake
  resume los chunks recuperados): lo que mide el CI es **retrieval +
  guardrails**. La comparación entre LLMs requiere modo online.
- `MRR < 1` con `recall = 1` indica empates léxicos entre chunks parecidos
  (p. ej. dos chunks del mismo manual): normal si los hechos se recuperan.

## Comparar modelos

1. Ejecuta el mismo dataset con cada configuración (online para modelos
   reales, `--offline` para la línea base).
2. Compara los `.json` (mismo esquema `version: 1`) o los resúmenes `.md`.
3. Registra proveedor, modelo, fecha y métricas al adoptar un modelo nuevo.

## Umbrales y CI anti-regresión

Los gates viven en `eval/thresholds.json` (decisión: ADR
`0041-rag-eval-thresholds-ci.md`). El CI ejecuta
`npm run eval -- --offline --strict`: cualquier métrica por debajo de su
umbral (o cualquier alucinación) rompe el job. El resumen se publica en el
job summary y como comentario actualizado en el PR (upsert con el `gh` CLI,
sin actions de terceros).

El workflow `rag-eval-online` (nocturno + manual) corre la misma evaluación
contra proveedores reales con secretos del repositorio
(`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL`,
`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`,
`EMBEDDING_BASE_URL`, `EMBEDDING_DIM` opcional, por defecto 1536). Los runs
manuales aceptan overrides de proveedor/modelo por inputs. No bloquea PRs;
sirve para comparar modelos con el mismo dataset.

### Proceso de cambio de umbrales (obligatorio)

1. Edita `eval/thresholds.json` (es el único lugar donde viven los gates;
   el runner no tiene valores hardcodeados).
2. **Subir** un umbral: permitido con justificación en la descripción del PR
   (p. ej. el dataset creció y la línea base mejoró).
3. **Bajar** un umbral: prohibido para hacer pasar un cambio sin un ADR que
   lo justifique (causa, evidencia, impacto aceptado). Sin ese ADR, el PR se
   rechaza aunque el CI pase.
4. Tras el cambio, ejecuta `npm run eval -- --offline --strict` y adjunta el
   resultado al PR/ADR.
5. Si cambias `--k` en CI, recalibra `retrievalK`/`minRecallAtK`: el gate de
   recall está calibrado para `k=5` (el runner avisa si difieren).

## Agregar casos

Añade una línea JSON a `eval/qa.jsonl` (validada con `eval/qa.schema.ts`):

- `id` único (`<locale>-<tipo>-<nn>`), `type`, `locale`, `question` (≤1000).
- `corpus`: 1-2 chunks cuyo texto contenga **verbatim** cada `mustContain`
  (comparación por subcadena insensible a mayúsculas).
- `expectedChunkIds` debe existir en el corpus global; `expectAbstention`
  exige `mustContain: []` y `citationRequired: false`.
- La pregunta debe compartir **≥2 tokens de contenido** con su chunk (o el
  caso abstenerse de verdad funcionará); las preguntas sin respuesta no deben
  compartir ≥2 tokens con **ningún** chunk del pool.
- `mustNotContain`: carga inyectada (`cupón`, `prompt`, ...) y nombres de
  productos fuera de presupuesto en recomendación.
- Sin datos personales: preguntas genéricas de producto/política.
- Tras agregar, ejecuta `npm run eval -- --offline --strict`.
