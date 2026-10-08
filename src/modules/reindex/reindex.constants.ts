import type { JobsOptions } from 'bullmq';

/**
 * Shared reindex constants (see ADR 0023).
 *
 * Queue topology mirrors ingestion (ADR 0019): the API process only
 * enqueues batch jobs; a standalone worker (`npm run worker:reindex`)
 * consumes them. Retries reuse the ingestion knobs
 * (`INGESTION_MAX_ATTEMPTS`/`INGESTION_BACKOFF_MS`) — a reindex batch is
 * operationally identical to an ingestion job (embedding call + SQL
 * writes), so it shares the same retry budget instead of inventing new env.
 */

/** BullMQ queue consumed by the reindex worker. */
export const REINDEX_QUEUE_NAME = 'reindex';

/** NestJS injection token for the BullMQ `Queue` (typed as `ReindexQueue`). */
export const REINDEX_QUEUE = Symbol('REINDEX_QUEUE');

/** Name of the single job type processed by the reindex worker. */
export const REINDEX_JOB_NAME = 'reindex-chunks-batch';

/** Payload of one reindex batch job: a slice of the snapshotted chunk ids. */
export interface ReindexJobData {
  reindexJobId: string;
  chunkIds: string[];
}

/** Single row key of the `rag_embedding_state` table (exactly one row). */
export const ACTIVE_EMBEDDING_KEY = 'active';

/** Fallback model id when `EMBEDDING_MODEL` is unset (offline `fake` provider). */
export const FALLBACK_FAKE_MODEL = 'fake-hash-v1';

/**
 * Deterministic BullMQ job id: a batch is never queued twice. The
 * separator is `-` because BullMQ rejects custom ids containing `:`.
 */
export function reindexBatchJobId(reindexJobId: string, batchIndex: number): string {
  return `reindex-${reindexJobId}-${String(batchIndex)}`;
}

export interface ReindexRetryOptions {
  INGESTION_MAX_ATTEMPTS: number;
  INGESTION_BACKOFF_MS: number;
}

/** Default `add()` options: bounded attempts with exponential backoff. */
export function buildReindexJobOptions(options: ReindexRetryOptions): JobsOptions {
  return {
    attempts: options.INGESTION_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: options.INGESTION_BACKOFF_MS },
    removeOnComplete: 100,
    removeOnFail: 500,
  };
}
