import { Queue } from 'bullmq';
import type { AppConfig } from '../../config/env.schema.js';
import { parseRedisConnection } from '../ingestion/ingestion.queue.js';
import { REINDEX_QUEUE_NAME, type ReindexJobData } from './reindex.constants.js';

/** Narrow type of the BullMQ queue owned by `ReindexModule` (only `add` is used). */
export type ReindexQueue = Pick<Queue<ReindexJobData>, 'add'>;

/**
 * Creates the `reindex` queue. Construction is lazy (no connection until
 * the first `add`), so the API boots offline; enqueue failures are caught
 * and logged by `ReindexService` instead of breaking admin calls.
 */
export function createReindexQueue(config: AppConfig): Queue<ReindexJobData> {
  const connection = parseRedisConnection(config.REDIS_URL);
  return new Queue<ReindexJobData>(REINDEX_QUEUE_NAME, {
    connection: { ...connection, maxRetriesPerRequest: null },
  });
}
