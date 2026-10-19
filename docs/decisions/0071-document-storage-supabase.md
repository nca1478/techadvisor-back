# 0071 — Document storage on Supabase (production) + local folder (development)

Date: 2026-10-19
Status: accepted

## Context

`backend/storage/` is ephemeral on Render (free plan, no persistent disk):
every deploy wipes the admin-uploaded RAG sources, while `Document.storageKey`
points at gone `<uuid>.bin` files (see ADR 0020, ADR 0067). The service
interface already isolates the layout for an object-store swap.

**Note on MCP context7:** active and consulted (`/supabase/supabase-js`,
storage bucket/upload/download docs). It reports v2.58.0, but
`npm view @supabase/supabase-js version` returns `2.118.0` as latest; the
registry version is installed (`@supabase/supabase-js@2.118.0 --save-exact`)
and recorded here.

## Decision

Dual driver behind the same `DocumentStorageService` interface
(`save/read/remove` keep returning `<uuid>.bin` keys, no DB migration):

- `DOCUMENTS_DRIVER=local` (development default): `onModuleInit` runs
  `mkdir -p` on `DOCUMENTS_DIR` (`./storage/documents`). Never imports or
  calls Supabase, so **no bucket is created in this environment**.
- `DOCUMENTS_DRIVER=supabase` (production): private Supabase Storage bucket
  (`SUPABASE_STORAGE_BUCKET`, default `documents`) + prefix folder
  (`SUPABASE_STORAGE_PREFIX`, default `storage/documents`). Boot ensures the
  bucket (`createBucket({ public: false })`, idempotent — already-exists is
  ignored) and the prefix (`.keep` placeholder when `list(prefix)` is empty;
  Supabase folders are virtual path prefixes). Objects are
  `<prefix>/<uuid>.bin` with `upsert: true`.
- Config (`env.schema.ts`): `DOCUMENTS_DRIVER` enum defaulting to `local`;
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` required only when driver is
  `supabase` (fail-fast refine). Service-role key is server-only; bucket
  stays private; validation (allowlist + magic bytes, 1..10 MiB) unchanged.
- Provisioning failures warn at boot without crashing; the next `save()`
  surfaces the real error.

## Consequences

- Production survives redeploys and scales past single-node; development
  keeps zero network dependencies.
- Existing 14 local `.bin` files need a one-off re-upload to Supabase
  (no automated migration in this task).
- New dependency: `@supabase/supabase-js@2.118.0` (exact).
