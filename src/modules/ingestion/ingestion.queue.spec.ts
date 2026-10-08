import { describe, expect, it } from 'vitest';
import { buildIngestionJobOptions, ingestionJobId } from './ingestion.constants.js';
import { parseRedisConnection } from './ingestion.queue.js';

/** Unit tests for queue wiring helpers (no Redis connection is opened). */
describe('ingestion queue helpers', () => {
  it('derives a stable job id per document for BullMQ dedup', () => {
    expect(ingestionJobId('doc-1')).toBe('ingestion:doc-1');
    expect(ingestionJobId('doc-1')).toBe(ingestionJobId('doc-1'));
    expect(ingestionJobId('doc-1')).not.toBe(ingestionJobId('doc-2'));
  });

  it('builds bounded attempts with exponential backoff', () => {
    expect(
      buildIngestionJobOptions({ INGESTION_MAX_ATTEMPTS: 5, INGESTION_BACKOFF_MS: 5000 }),
    ).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  });

  it('parses REDIS_URL into host and port', () => {
    expect(parseRedisConnection('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
    });
    expect(parseRedisConnection('redis://cache.internal:6380/2')).toEqual({
      host: 'cache.internal',
      port: 6380,
    });
  });

  it('rejects non-redis schemes', () => {
    expect(() => parseRedisConnection('postgres://localhost/db')).toThrow(/redis:\/\//);
  });
});
