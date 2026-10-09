# 0024 — Provider-agnostic LLM generation layer (fake + OpenAI-compatible + Anthropic)

Date: 2026-10-09
Status: accepted

## Context

AGENTS.md §7 requires generation (like embeddings, ADR 0016) to be swappable
by configuration behind `LlmProvider { generate, stream }`, with prompts kept
neutral (no provider-exclusive functions) and structured output via plain JSON
+ Zod. Fase 3 (product Q&A) needs this seam now. The task mandates one native
adapter for a default provider (Anthropic is the worked example) using its
official SDK, plus the generic OpenAI-compatible adapter and a scripted fake.

**MCP context7:** active and used — resolved `@anthropic-ai/sdk` to
`/anthropics/anthropic-sdk-typescript` and confirmed the Messages API shape
(`messages.create`/`messages.stream`, `system` top-level, `max_tokens`
required, `content[].type === 'text'`, `usage.input_tokens/output_tokens`).
Installed `@anthropic-ai/sdk@0.132.1` (exact, via `npm view` latest).

## Decision

- **Interface only:** consumers inject the `LLM_PROVIDER` token typed as
  `LlmProvider` (`providerName`, `model`, `generate`, `stream`). SDK/HTTP
  code lives exclusively in `src/modules/ai/adapters/`.
- **Three adapters:** `FakeLlmAdapter` (scripted queue/map/default, records
  calls, tests/dev only), `OpenAiCompatibleLlmAdapter` (any
  `/chat/completions` API incl. SSE streaming, plain `fetch`), and
  `AnthropicLlmAdapter` (native Messages API via the official SDK; the
  generic adapter cannot cover its auth, top-level `system`, required
  `max_tokens`, or content-block responses).
- **Shared policy via `common/retry.ts`:** exponential backoff + jitter,
  honors `Retry-After`, retries only 429/5xx/network/timeout. Failures
  normalize to `AiProviderError` codes (`auth`/`rate_limited`/`timeout`/
  `bad_request`/`server`/`network`/`config`); messages never carry prompt
  text or keys. Token counts surface as `{ inputTokens, outputTokens }`
  only when the provider reports them; every result also carries
  `latencyMs` so consumers can log provider/model/latency/tokens metadata
  without ever logging prompts.
- **Structured output:** `common/generate-json.ts` (`generateJson`) asks for
  ONLY JSON, strips fences, validates with Zod, and retries exactly once
  with a correction message listing the issues; then throws the typed
  `LlmJsonError` (attempts + issues, no content). No tool-calling, no
  response-format flags.
- **Config (default `fake`, boots offline):** `LLM_PROVIDER=
  fake|openai-compatible|anthropic`, `LLM_MODEL` (required unless `fake`),
  `LLM_API_KEY`, `LLM_BASE_URL` (required for `openai-compatible`,
  optional override for `anthropic`, unused for `fake`), plus
  `LLM_TIMEOUT_MS` (default 60000), `LLM_MAX_ATTEMPTS` (3),
  `LLM_RETRY_BASE_DELAY_MS`/`LLM_RETRY_MAX_DELAY_MS` (500/8000) and
  `LLM_MAX_TOKENS` (1024). Streaming retries cover stream establishment
  only — mid-stream failures surface as-is.
- **New dependency:** `@anthropic-ai/sdk` 0.132.1 (exact), imported only
  inside `adapters/anthropic-llm.adapter.ts`.

## Consequences

- Swapping models/providers = env change + (for a new vendor) one adapter
  file + one factory branch; consumer code is untouched (proven by
  `llm-provider.factory.spec.ts`, which runs one shared consumer against
  all three adapters).
- No advisor/support code yet — that arrives with Fase 3; this ADR covers
  the generation seam only, no speculative code.
- Non-streaming token usage is available per call; streaming usage is left
  to consumers (deltas only), revisit with metrics if cost attribution
  needs it.
