import { Queue } from 'bullmq';
import type { AppConfig } from '../../config/env.schema.js';
import { INGESTION_QUEUE_NAME, type IngestionJobData } from './ingestion.constants.js';

/** Narrow type of the BullMQ queue owned by `IngestionModule` (only `add` is used). */
export type IngestionQueue = Pick<Queue<IngestionJobData>, 'add'>;

/** BullMQ/ioredis connection options derived from `REDIS_URL`. */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, unknown>;
}

/** Parses `REDIS_URL` (validated as a URL by the env schema) for BullMQ. */
export function parseRedisConnection(redisUrl: string): RedisConnectionOptions {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      `REDIS_URL must use the redis:// or rediss:// scheme, got "${parsed.protocol}"`,
    );
  }
  const connection: RedisConnectionOptions = {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port) || 6379,
  };
  if (parsed.username) {
    connection.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    connection.password = decodeURIComponent(parsed.password);
  }
  const db = parsed.pathname.replace('/', '');
  if (db !== '') {
    const dbIndex = Number(db);
    if (Number.isInteger(dbIndex) && dbIndex >= 0) {
      connection.db = dbIndex;
    }
  }
  if (parsed.protocol === 'rediss:') {
    connection.tls = {};
  }
  return connection;
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
