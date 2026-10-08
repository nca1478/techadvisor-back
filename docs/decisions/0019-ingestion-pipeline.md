# 0019 — Ingestion pipeline: extraction libraries, BullMQ topology, chunking and idempotency

Date: 2026-10-08
Status: accepted

## Context

Task P2.4 turns documents into chunks with embeddings, idempotently and
asynchronously (AGENTS.md §7: extraction → chunking → batched embeddings →
persistence; `PENDING → PROCESSING → READY/FAILED`; re-ingest without changes
must not duplicate chunks nor call the provider).

**Note on MCP context7:** it was available and was used to verify the BullMQ
v6 Queue/Worker usage (separate connections, `attempts` + `backoff` job
options) and the `pdf-parse` v2 API (`new PDFParse({ data })` +
`getText()`). Versions below were pinned with `npm view <pkg> version`
before installing:

- `bullmq@6.3.11` (peers accept `ioredis>=5`; we install `ioredis@6.0.0`)
- `pdf-parse@2.4.5` (v2 `PDFParse` class API)
- `cheerio@1.2.0`

## Decision

### Extraction libraries (one per format, zero native dependencies)

- **PDF → `pdf-parse@2.4.5`.** Pure TypeScript, no binaries, v2 ESM-friendly
  API. Only this file (`document-extractor.service.ts`) imports it.
- **HTML → `cheerio@1.2.0`.** Standard server-side HTML parser;
  extraction = `cheerio.load(html)` → remove `script`/`style`/`noscript` →
  block-level elements joined with newlines (headings kept as `#` markers
  so the chunker sees section boundaries).
- **Markdown / plain text → no library.** Markdown is already text: a small
  deterministic cleaner strips fences, link/image markup (keeping link text),
  heading markers are normalized to `#` section headers, and markdown tables
  (`| … |` line runs) are passed through untouched so the chunker can keep
  them whole. A new markdown library would add attack surface for no gain.
- Document bytes are **untrusted data**: extraction never interprets embedded
  instructions; failures surface as legible `ExtractionError`s (format +
  reason, never content dumps).

### Queue / worker topology: same module, separate processes

- One BullMQ queue, `ingestion`, owned by `IngestionModule`.
- The **API process only enqueues** (`IngestionService.enqueueDocument`,
  `jobId = ingestion:{documentId}` so a document is never queued twice).
- A **standalone worker process** (`src/modules/ingestion/ingestion.worker.ts`,
  `npm run worker:ingestion`) boots the full application context (same
  services, same config — `createApplicationContext`, no HTTP server) and
  runs one BullMQ `Worker` (concurrency from `INGESTION_CONCURRENCY`,
  default 4). The full context (rather than a minimal module subset) was
  chosen so the worker can never drift from the API wiring; the cost is one
  heavier boot.
- Rationale: API and worker scale independently and a poison document can
  never block HTTP; no code is duplicated (both share `IngestionService`
  + `processIngestionJob`). Local dev runs `npm run dev` and (after
  `npm run build`) `npm run worker:ingestion` side by side.
- The worker runs from compiled output (`node dist/...`, like `start:prod`),
  not via `tsx` on sources: loading the app graph directly with `tsx`
  fails on a **pre-existing** native-ESM circular import in the auth modules
  (`AuthService` undefined dependency — reproduced on clean `main` without
  this task's changes, so it is out of scope here). The Nest CLI (`npm run
  dev`), `nest build` + `node`, and vitest all boot the same graph fine.
- **Retries:** `attempts = INGESTION_MAX_ATTEMPTS` (default 5) with
  exponential backoff from `INGESTION_BACKOFF_MS` (default 5000 ms) —
  BullMQ-native, no custom scheduler. After the last attempt the job lands in
  the failed set and the document stays `FAILED` with its error, re-runnable
  via `IngestionService.retryDocument` (→ `PENDING` + re-enqueue).
- If Redis is unreachable, product/admin writes **never fail**: the document
  row stays `PENDING` and enqueue errors are caught and logged.

### Chunking: ~300–500 tokens, ~50 overlap, structure-aware

Token estimate `tokens ≈ ceil(chars / 4)`. Targets: `TARGET ≈ 1600` chars
(~400 tokens), `MAX ≈ 2000` chars (~500 tokens), overlap `≈ 200` chars
(~50 tokens, cut at a word boundary).

- Split into sections on `#` headings (each chunk records its 0-based
  `section`); accumulate blank-line paragraphs until `MAX`, then emit and
  restart with the trailing-overlap prefix.
- Consecutive `| … |` lines form a **table block that is never split**:
  an oversize table (> `MAX`) becomes one oversize chunk rather than a
  broken one (spec comparisons must read whole rows).
- Pure function (`chunker.ts`), fully unit-tested, no I/O.

### Idempotency and transactional replacement

- `content_hash = sha256(cleanedText)`. If the document is already `READY`
  with the same hash, ingestion returns `{ skipped: true }` **before**
  calling the embedding provider (asserted with a spy in tests).
- If the hash changed, old chunks are `DELETE`d and new chunks (+ vectors)
  `INSERT`ed **inside one Prisma interactive transaction**: atomic — a
  mid-pipeline failure rolls back, so the document never sits chunkless.
- Chunk vectors go to the column matching the configured
  `EMBEDDING_DIM` (`1536 → embedding vector`, `2048 → embedding_halfvec`);
  any other width fails loudly (it needs its own migration + ADR, per
  AGENTS.md §7). Every chunk records `embedding_model`/`embedding_dim`.

### Product SPEC_SHEET auto-ingestion (no PII)

- New additive column `documents.source TEXT NOT NULL DEFAULT 'manual'`
  plus `@@unique([productId, source])`: the auto-generated SPEC_SHEET per
  product (`source = 'auto:product'`) is precisely identifiable without
  title conventions. Migration `..._add_document_source` (additive).
- `ProductSpecSheetService.syncProduct(productId)`: `ACTIVE` products get
  their SPEC_SHEET upserted (readable markdown from name + description +
  specs table) and enqueued; non-`ACTIVE` products get the auto doc deleted
  so stale specs never pollute retrieval. Called (fire-and-forget,
  failure-safe) from `AdminService` product create/update/status writes.
- The corpus only ever contains catalog text — never user emails, addresses
  or other PII (restriction enforced by construction: the builder input is
  the product row).

## Consequences

- New deps: `bullmq`, `ioredis`, `pdf-parse`, `cheerio` (exact versions in
  `package.json`; recorded here per AGENTS.md §2).
- New env vars (all with safe defaults): `INGESTION_MAX_ATTEMPTS=5`,
  `INGESTION_BACKOFF_MS=5000`, `INGESTION_CONCURRENCY=4`.
- No HTTP surface in this task: triggering is service-level
  (`enqueueDocument` / `ingestDocument`) plus the product hook; admin
  upload endpoints arrive with the Fase 2 admin task.
- Tests: pure unit specs for chunker/cleaner/extractor; DB integration spec
  for the full pipeline with the fake adapter (same-hash skip without a
  provider call, changed-content replacement, provider-failure → `FAILED`
  + retry).
