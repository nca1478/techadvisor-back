/**
 * Provider-agnostic generation contract (see AGENTS.md §7 and ADR 0024).
 *
 * Every consumer (advisor, support, eval) depends ONLY on this interface
 * plus the `LLM_PROVIDER` token. Provider SDKs or HTTP clients live
 * exclusively inside `modules/ai/adapters/` and are never imported
 * elsewhere — swapping models/providers is a config change.
 *
 * Prompts are neutral plain text with clear delimiters: no tool-calling,
 * no function schemas, no provider-exclusive features. Structured output
 * goes through `common/generate-json.ts` (JSON + Zod + one retry).
 */

/** NestJS injection token for the configured `LlmProvider`. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateRequest {
  /** Neutral system prompt (plain text, delimited context, citation rules). */
  system: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmGenerateResult {
  /** Full assistant text (deltas concatenated for streams). */
  text: string;
  /** Token counts when the provider reports them; otherwise undefined. */
  usage?: LlmUsage;
  /** Wall-clock latency of the call (metadata for logs, never content). */
  latencyMs: number;
}

export interface LlmProvider {
  /** Provider id for metadata logs (e.g. 'openai-compatible'). No secrets. */
  readonly providerName: string;
  /** Model id from configuration. */
  readonly model: string;
  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult>;
  /** Streams text deltas in order; usage/latency are consumer-side. */
  stream(req: LlmGenerateRequest): AsyncIterable<string>;
}
