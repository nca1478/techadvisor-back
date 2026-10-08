import { Queue } from 'bullmq';
import type { AppConfig } from '../../config/env.schema.js';
import { INGESTION_QUEUE_NAME, type IngestionJobData } from './ingestion.constants.js';

/** Narrow type of the BullMQ queue owned by `IngestionModule` (only `add` is used). */
export type IngestionQueue = Pick<Queue<IngestionJobData>, 'add'>;

/** Parses `REDIS_URL` (validated as a URL by the env schema) for BullMQ. */
export function parseRedisConnection(redisUrl: string): { host: string; port: number } {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:') {
    throw new Error(`REDIS_URL must use the redis:// scheme, got "${parsed.protocol}"`);
  }
  return { host: parsed.hostname || 'localhost', port: Number(parsed.port) || 6379 };
}

/**
 * Creates the `ingestion` queue. Construction is lazy (no connection until
 * the first `add`), so the API boots offline; enqueue failures are caught
 * and logged by `IngestionService` instead of breaking product writes.
 */
export function createIngestionQueue(config: AppConfig): Queue<IngestionJobData> {
  const connection = parseRedisConnection(config.REDIS_URL);
  return new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
    connection: { ...connection, maxRetriesPerRequest: null },
  });
}
