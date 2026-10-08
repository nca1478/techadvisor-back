# 0020 — Admin document upload: local disk storage, strict validation, soft delete

Date: 2026-10-08
Status: accepted

## Context

Task P2.5 needs admin-managed RAG corpus documents: upload a file (or
register a URL), track ingestion status, re-ingest, and remove documents
from search. AGENTS.md §5 forbids executing or interpreting file content
and forbids exposing filesystem paths to clients.

**Note on MCP context7:** not available in this environment, so no
documentation lookup was performed. No new dependencies are installed by
this task: multipart parsing uses `multer` (already a transitive
dependency of `@nestjs/platform-express`), PDF/HTML/text extraction
reuses the P2.4 extractor, and file typing is structural (no
`@types/multer`). Verified with `npm view` that nothing needed pinning
because nothing was added.

## Decision

### Where files live: local disk under `DOCUMENTS_DIR` (dev and current scope)

- Files are stored on local disk under `DOCUMENTS_DIR`
  (default `./storage/documents`, resolved to an absolute path at boot,
  created with `mkdir -p`). The directory is gitignored and holds no code.
- The stored filename is the document UUID (`<id>.bin`) — never the
  user-supplied name, so there is no path traversal and no extension-based
  content sniffing by the OS. The original name is kept in `documents.file_name`
  for display only.
- The API never returns filesystem paths: `storage_key` is internal-only
  (not present in any DTO or OpenAPI schema), and there is no
  file-download endpoint in this task. Retrieval/ingestion read the bytes
  server-side only.
- Rationale: simplest durable option for development and the current
  single-node scope; the `DocumentStorageService` interface isolates the
  layout so a future object-store (S3/GCS) backend only replaces that
  service, never the API. No volume plugin or Docker change is needed:
  the directory lives next to the backend checkout, like SQLite-era dev
  habits, and production deployment stays out of scope until a later ADR.

### Strict validation (before anything is persisted or queued)

- Size: `1..DOCUMENTS_MAX_BYTES` (default 10 MiB, hard cap = the
  `MAX_JOB_BYTES` 10 MiB queue payload limit — anything larger could never
  travel through BullMQ, so it is rejected at the edge with 400).
- Declared MIME must be in the allowlist
  (`application/pdf`, `text/html`, `text/markdown`, `text/plain`); then the
  **real type wins**: magic-byte sniffing (`%PDF-` for PDF, `<`-start for
  HTML, UTF-8 text otherwise) must resolve to one of the four extractor
  formats, else 400 with a legible message (e.g. executables, archives,
  images are rejected even when mislabeled).
- URL registration (`POST /admin/documents` with `sourceUrl`) fetches
  server-side with a 15 s timeout and the same size/type validation on the
  fetched bytes. SSRF note: this endpoint is ADMIN-only (trusted
  back-office users), `http(s)` schemes only, and the fetched bytes are
  treated as untrusted data exactly like uploads (text extraction only,
  never interpreted). A stricter egress policy (allowlist, no-link-local)
  is deferred to a later ADR if the threat model requires it.

### Ingestion triggering

- After persisting, the service calls `IngestionService.enqueueDocument`.
  When Redis is unreachable it falls back to **inline synchronous
  ingestion** (`ingestDocument`) so a single-process dev/test setup still
  reaches `READY` without a worker; document status (`FAILED` + legible
  `error`) is owned by `IngestionService` either way.

### Soft delete

- `DELETE /admin/documents/:id` sets `documents.deleted_at` and deletes
  the document's chunks transactionally, so its content immediately stops
  matching any search (full-text and vector alike). The row itself is kept
  for audit; list/detail endpoints exclude `deleted_at IS NOT NULL` rows
  (detail answers 404). No `DROP`, no column renames — all additive.
