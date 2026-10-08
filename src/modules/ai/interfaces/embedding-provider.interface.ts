/**
 * Provider-agnostic embedding contract (see AGENTS.md §7 and ADR 0016).
 *
 * Every consumer (ingestion, retrieval, advisor) depends ONLY on this
 * interface plus the `EMBEDDING_PROVIDER` token. Provider SDKs or HTTP
 * clients live exclusively inside `modules/ai/adapters/` and are never
 * imported elsewhere — swapping models/providers is a config change.
 */

/** NestJS injection token for the configured `EmbeddingProvider`. */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/** Hint for providers that support distinct document/query encodings. */
export type EmbedKind = 'document' | 'query';

export interface EmbedOptions {
  kind?: EmbedKind;
}

export interface EmbeddingProvider {
  /** Model id, persisted per chunk in `chunks.embedding_model`. */
  readonly model: string;
  /** Vector length, persisted per chunk in `chunks.embedding_dim`. */
  readonly dimensions: number;
  /**
   * Embeds `texts` preserving order (output[i] corresponds to texts[i]).
   * Implementations batch large inputs internally; callers pass the full
   * list. Never receives secrets or personal data logging — see adapters.
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}
