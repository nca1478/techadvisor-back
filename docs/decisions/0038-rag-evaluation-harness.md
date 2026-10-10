# 0038 — Harness de evaluación del RAG

Fecha: 2026-10-10
Estado: aceptado

## Contexto

La Fase 7 exige medir el RAG de forma repetible y comparable entre modelos
(`npm run eval`), con modo `--offline` para CI. El harness no puede exigir
PostgreSQL/Redis ni claves reales en CI, pero debe ejercitar el código de
producción, no una reimplementación paralela.

## Decisión

`eval/` contiene: `qa.jsonl` (dataset, 54 casos ES/EN con su propio `corpus`
de chunks sintéticos), `run.ts` (CLI), `offline-harness.ts` y `metrics.ts`
(funciones puras).

- El corpus es la unión de los chunks de todos los casos (distractores
  realistas incluidos).
- Retrieval híbrido con el `fuseRankings` (RRF) real: rama vectorial por
  coseno sobre el `EmbeddingProvider` configurado (fake determinista en
  offline, real en online) + rama léxica por overlap de tokens distintos
  (≥2) como equivalente sin-BD de la rama `tsvector`.
- Abstención sin llamar al LLM cuando no hay evidencia léxica, con el mismo
  umbral de score que `AdvisorService` (0.016); citas con `buildCitations`
  y `extractCitationNumbers` reales.
- Proveedores creados con `createLlmProvider` / `createEmbeddingProvider`
  desde env + flags (`--llm-provider`, `--llm-model`,
  `--embedding-provider`, `--embedding-model`); `--offline` fuerza los fakes.
- Offline el `FakeLlmAdapter` responde con texto compuesto solo desde los
  chunks entregados: el CI mide retrieval + guardrails (las métricas de
  generación son ~perfectas por construcción); la comparación entre LLMs es
  online.
- Reglas deterministas en código (veredicto de compatibilidad, filtro de
  presupuesto/stock): el LLM solo redacta, como en producción.
- Reportes versionados (esquema `version: 1`) en
  `eval/results/<fecha>-<llm>__<embeddings>.json` + `.md` (generados,
  ignorados por git). Umbrales: alucinación 0, abstención ≥ 80%,
  citas ≥ 80% (`--strict` para CI).

## Alternativas descartadas

- E2E por HTTP contra la API: exige BD con seed y red; frágil en CI.
- Métricas solo con LLM-juez: no determinista y con coste por pasada.

## Consecuencias

- Añadir un caso = una línea en `qa.jsonl` (ver `docs/rag/evaluacion.md`).
- Cambiar de modelo de embeddings/LLM no toca código, solo config.
- La rama léxica no sustituye a `tsvector` en producción; es un proxy
  documentado para evaluación sin BD.
