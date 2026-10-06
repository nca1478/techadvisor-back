# 0004 — OpenAPI with @nestjs/swagger, docs-json for frontend type generation

Date: 2026-10-06
Status: accepted

## Context

The frontend must not import backend code; the API contract travels via
OpenAPI (`GET /api/v1/docs-json`) and the frontend generates types from it
with `npm run api:types`. Versions were checked with the Context7 MCP
(library `/nestjs/swagger`) and `npm view @nestjs/swagger version` before
installing.

## Decision

- **`@nestjs/swagger@12.0.2` pinned** (matches the installed `@nestjs/*@12`
  line; `npm view` resolves `12.0.2` as latest). Used code-first
  (`DocumentBuilder` + `SwaggerModule.createDocument` + decorators such as
  `@ApiOkResponse`/`@ApiProperty`), so the spec always reflects the running
  controllers and DTOs.
- **Only the JSON document is served, no Swagger UI** (`ui: false, raw:
  ['json']`): this phase needs the machine-readable contract, not an
  interactive explorer.
- **Path via the global prefix**: `SwaggerModule.setup('docs', …,
  { useGlobalPrefix: true })` exposes the UI root at `/api/v1/docs` and the
  JSON document at its default `{path}-json`, i.e. **`GET
  /api/v1/docs-json`** (verified in `node_modules/@nestjs/swagger`:
  a custom `jsonDocumentUrl` would be prefixed again, so the default is what
  yields the required path).
- **Disabled in production by configuration**: the document is only
  registered when `DOCS_ENABLED=true` (new boolean env var, default `true`;
  see `.env.example`). Production sets `DOCS_ENABLED=false`.
- **Error format documented in the contract**: the global filter's uniform
  payload `{ statusCode, code, message, details? }` is an `ErrorResponseDto`
  plus an `ApiUniformErrorResponses()` decorator (400/404/500) applied to the
  base controllers, so generated frontend types include the error shape.

## Consequences

- New dependency: `@nestjs/swagger@12.0.2` (+ its transitive deps).
- New env vars: `SUPPORTED_LOCALES` (default `en,es`, must include
  `DEFAULT_LOCALE`) and `DOCS_ENABLED` (default `true`).
- The frontend's `api:types` script depends on this endpoint being enabled
  wherever types are generated (local/dev/CI-with-services).
