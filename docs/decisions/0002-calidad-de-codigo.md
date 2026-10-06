# 0002 — Code quality: ESLint, Prettier, Husky, tests

Date: 2026-10-06
Status: accepted

## Context

P0.2 requires per-repo quality gates (lint, typecheck, test) running on every
commit and in CI. This repo (`backend/`) is independent from `frontend/`: own
`package.json`, own configs, no shared packages or relative imports (see
0001-estructura-de-proyectos.md). The scaffold shipped with oxlint + Vitest and
a minimal `.prettierrc`.

## Decision

- **Linter: ESLint (flat config) in `eslint.config.mjs`.** Replaces oxlint as the
  `npm run lint` gate (`eslint .` / `eslint . --fix`). oxlint packages stay
  installed for now (Nest 12 scaffold default) but are no longer the gate;
  removal will be evaluated separately to keep this change incremental.
  - Base: `@eslint/js` recommended + `typescript-eslint` **strictTypeChecked**
    (type-aware via `projectService: true`, consistent with `strict: true` in
    `tsconfig.json`) + `eslint-config-prettier` (flat) so Prettier owns
    formatting and ESLint never conflicts with it.
  - `@typescript-eslint/no-explicit-any: error`. Exception workflow for the
    rare justified case:
    ```ts
    // justificado: <motivo>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ```
    `reportUnusedDisableDirectives: error` keeps stale disables failing lint.
  - `@typescript-eslint/no-extraneous-class` with `allowWithDecorator: true`
    because NestJS modules/controllers are idiomatic decorated (often empty)
    classes.
  - Test override (`test/**/*.ts`, `src/**/*.spec.ts`): `no-unsafe-*`
    (argument/assignment/call/member-access) off. Rationale: test helpers
    (e.g. Nest `getHttpServer()` + supertest) leak implicit `any` from
    third-party types; the explicit-`any` ban stays on everywhere.
- **Formatter: Prettier with this repo's own `.prettierrc`** (singleQuote,
  trailingComma all, printWidth 100, tabWidth 2, semi, lf). `.prettierignore`
  covers `dist/`, `coverage/`, `node_modules/`. Config is intentionally
  duplicated (not shared) with the frontend repo.
- **Hooks: Husky + lint-staged.** `prepare: husky` script; `.husky/pre-commit`
  runs `npx lint-staged`; `.lintstagedrc.json` runs `eslint --fix` and
  `prettier --write` on staged `*.{ts,mts,cts,mjs,js,json}`. No commitlint or
  other tools (per task restrictions).
- **Tests: keep Vitest (do NOT migrate to Jest).** AGENTS.md §2 allows
  "Vitest/Jest (unit)"; the scaffold already wires Vitest (`vitest run`,
  `src/app.controller.spec.ts` trivial test green). Migrating to Jest now
  would be a destructive rewrite with no quality gain, against the incremental
  rule. Simplest option chosen and recorded here. `npm test` = `vitest run`.
- **Scripts:** `lint` (`eslint .`), `lint:fix`, `typecheck` (`tsc --noEmit`),
  `test` (`vitest run`) — all exit 0 on the scaffold.

## Versions pinned (latest per Context7 docs + `npm view`, 2026-10-06)

Context7 MCP active; docs consulted for `typescript-eslint` (flat
strictTypeChecked setup) and `vitest`. Installed:

- `eslint@^9.39.5` (9.x line, **not** latest 10.x: `eslint-config-next` peers
  and the Next.js frontend require ESLint 9; keeping both repos on 9.x avoids a
  major split for zero benefit).
- `@eslint/js@^9.39.5`, `typescript-eslint@^8.71.1`,
  `eslint-config-prettier@^10.1.8`, `husky@^9.1.7`, `lint-staged@^17.6.0`.
- Kept (scaffold): `vitest@^4.1.2`, `prettier@^3.4.2`
  (3.9.9 is latest but the 3.4.x line satisfies the config used; upgrade
  deferred as non-essential), `oxlint` (unused gate, see above).

## Consequences

- Every commit runs ESLint --fix + Prettier on staged files; a lint error
  blocks the commit.
- `any` requires a `// justificado:` comment plus a targeted disable; CI can
  enforce the same via `npm run lint`.
- Future providers/SDKs do not affect this setup (no AI code in this task).
