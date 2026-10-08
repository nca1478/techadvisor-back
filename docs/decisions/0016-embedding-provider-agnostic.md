# 0016 — Provider-agnostic embedding layer (fake + OpenAI-compatible)

Date: 2026-10-08
Status: accepted

## Context

AGENTS.md §7 requires LLM and embedding providers to be swappable by
configuration, with storage fixed on pgvector in the same PostgreSQL.
The ingestion pipeline (later task) needs an `EmbeddingProvider` seam now,
plus shared behavior every adapter needs: batching, retries with backoff,
timeouts, and normalized errors.

**Note on MCP context7:** it was available in this environment, but no
lookup was needed — no new dependency was installed. The generic adapter
uses the Node 24 global `fetch` and the fake adapter uses `node:crypto`,
so there was nothing to version-check.

## Decision

- **Interface only:** consumers inject the `EMBEDDING_PROVIDER` token typed
  as `EmbeddingProvider` (`model`, `dimensions`, `embed`). HTTP/SDK code
  lives exclusively in `src/modules/ai/adapters/`.
- **Two adapters:** `FakeEmbeddingAdapter` (deterministic SHA-256 hash
  vectors, tests/dev only) and `OpenAiCompatibleEmbeddingAdapter`
  (any `/embeddings` JSON API: OpenAI, OpenRouter, vLLM, Ollama, …).
- **Shared utils in `common/`:** `splitIntoBatches` (sequential batches of
  `EMBEDDING_BATCH_SIZE`, order-preserving) and `withRetry` (exponential
  backoff + jitter, honors `Retry-After`, retries only 429/5xx/network/
  timeout). Failures normalize to `AiProviderError` codes
  (`auth`/`rate_limited`/`timeout`/`bad_request`/`server`/`network`/
  `config`); messages never carry input texts or keys.
- **Dimension reduction:** `EMBEDDING_DIM` is always sent as the request
  `dimensions` field (honored by OpenAI `text-embedding-3-*` and several
  compatible servers) and every response vector is length-checked —
  a wrong-length vector fails loudly instead of polluting the column.
- **Config:** `EMBEDDING_PROVIDER=fake|openai-compatible` (default `fake`,
  so the app boots offline), `EMBEDDING_MODEL`/`EMBEDDING_API_KEY`/
  `EMBEDDING_BASE_URL`, `EMBEDDING_DIM` (1–2000, pgvector indexed cap),
  plus `EMBEDDING_BATCH_SIZE`, `EMBEDDING_TIMEOUT_MS`,
  `EMBEDDING_MAX_ATTEMPTS`, `EMBEDDING_RETRY_BASE_DELAY_MS`,
  `EMBEDDING_RETRY_MAX_DELAY_MS`. `openai-compatible` without base URL
  or model fails fast at boot; the API key stays optional (local servers
  such as Ollama need none).
- **No `LlmProvider` yet:** generation interfaces arrive with the Fase 3
  task; this ADR covers embeddings only, no speculative code.

## Consequences

- Swapping models/providers = env change + (for a new vendor) one adapter
  file + one factory branch; consumer code is untouched (proven by
  `ai-provider.factory.spec.ts`, which runs one shared consumer against
  both adapters).
- Every stored chunk must still record `embedding_model`/`embedding_dim`;
  model switches follow the non-destructive reindex procedure in
  AGENTS.md §7, never a column rewrite.
- Concurrent-batch uploads were deliberately left sequential: simpler
  rate-limit behavior; revisit with metrics if ingestion throughput demands
  it.
