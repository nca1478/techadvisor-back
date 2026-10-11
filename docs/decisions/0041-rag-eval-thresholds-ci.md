# 0041 — Umbrales versionados y CI anti-regresión del RAG

Fecha: 2026-10-11
Estado: aceptado

## Contexto

La Fase 7 pedía "umbrales mínimos en CI para no degradar calidad", pero los
umbrales vivían hardcodeados en `eval/run.ts` y solo cubrían alucinación,
abstención y citas (sin puerta de `recall@k`). Además, el resultado de la
evaluación solo era visible en el log del job: había que abrirlo para ver
las métricas de un PR. Se necesita comparar modelos reales periódicamente
sin bloquear los PRs.

## Decisión

- `eval/thresholds.json` (versionado, `version: 1`) es la única fuente de
  los gates: `recall@5 ≥ 0.90`, abstención ≥ 0.80, citas ≥ 0.80,
  alucinaciones ≤ 0. `eval/run.ts` los carga con `--thresholds PATH`
  (override para experimentos locales) y falla con `--strict` si **alguna**
  métrica cruza su umbral. La lógica pura vive en `eval/thresholds.ts`
  (`loadThresholds` + `checkThresholds`) con tests en
  `eval/thresholds.spec.ts`.
- El reporte (JSON/Markdown) registra los umbrales aplicados, incluyendo el
  nuevo `minRecallAtK` en el esquema del reporte.
- CI (`ci.yml`): tras `npm run eval -- --offline --strict`, un paso
  `if: always()` publica el `.md` en el job summary (`$GITHUB_STEP_SUMMARY`,
  nativo) y otro paso actualiza un único comentario en el PR (upsert por
  marcador `<!-- rag-eval-summary -->`) usando **solo el `gh` CLI
  preinstalado** en los runners — sin actions de terceros, por eso no se
  requiere un ADR de dependencia. El comentario tiene `continue-on-error`
  porque en PRs desde forks el token es de solo lectura; la puerta
  `--strict` sigue rompiendo el job aunque el comentario falle.
- Workflow `eval-online.yml` (nocturno `0 3 * * *` + `workflow_dispatch`
  con overrides de proveedor/modelo): ejecuta la misma evaluación en modo
  online con secretos del repositorio, también con `--strict`. No bloquea
  PRs; su summary sirve para comparar modelos con el mismo dataset.
- **Restricción:** bajar cualquier umbral para hacer pasar un cambio exige
  un ADR que lo justifique. El proceso está en `docs/rag/evaluacion.md`.

## Alternativas descartadas

- `actions/github-script` o actions de comentario del marketplace para el
  comentario del PR: dependencia adicional solo para envolver la API; el
  script `gh api` (upsert con marcador) hace lo mismo sin instalar nada.
- Subir reportes como artifacts (`actions/upload-artifact`): añade retención
  y pasos; el summary + comentario cubren la visibilidad del PR y los
  reportes online quedan en el summary del run nocturno.
- Umbral de `recall@5 = 1.0`: la línea base offline da 100%, pero 0.90 deja
  margen para evoluciones del dataset sin enmascarar regresiones reales;
  cualquier bajada posterior requiere ADR igualmente.

## Consecuencias

- Un cambio que degrade recall, abstención, citas o introduzca alucinaciones
  rompe el CI (verificado por `thresholds.spec.ts` + gate `--strict`).
- El modo online hereda los mismos umbrales; si un modelo real queda por
  debajo de forma estable, se ajusta por ADR, no por conveniencia.
- Añadir una métrica nueva = campo en `thresholds.json` + su esquema +
  `checkThresholds` + test + documentar en `docs/rag/evaluacion.md`.
