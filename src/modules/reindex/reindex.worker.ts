import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from '../../app.module.js';
import { parseEnv } from '../../config/env.schema.js';
import { parseRedisConnection } from '../ingestion/ingestion.queue.js';
import { REINDEX_QUEUE_NAME, type ReindexJobData } from './reindex.constants.js';
import { processReindexJob } from './reindex.processor.js';
import { ReindexService } from './reindex.service.js';

/**
 * Standalone reindex worker entrypoint (`npm run worker:reindex`).
 *
 * Same topology as ingestion (ADR 0019): the API process only enqueues
 * batch jobs while this separate process consumes the `reindex` queue, so
 * embedding bursts never block HTTP and both sides scale independently.
 * The worker shares the full application context (same services, same
 * config) — `createApplicationContext` boots no HTTP server. Run from
 * compiled output (`npm run build && npm run worker:reindex`).
 */
async function bootstrap(): Promise<void> {
  const config = parseEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  const reindex = app.get(ReindexService);

  const worker = new Worker<ReindexJobData>(
    REINDEX_QUEUE_NAME,
    (job) => processReindexJob(job, reindex),
    {
      connection: { ...parseRedisConnection(config.REDIS_URL), maxRetriesPerRequest: null },
      concurrency: config.INGESTION_CONCURRENCY,
    },
  );
  worker.on('failed', (job, error) => {
    // Batch progress already accounts per-chunk failures (see ReindexService);
    // this log keeps the job id visible for operations.
    console.error(`Reindex job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  });
  console.log(
    `Reindex worker listening on queue "${REINDEX_QUEUE_NAME}" (concurrency ${String(config.INGESTION_CONCURRENCY)})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Reindex worker received ${signal}, closing...`);
    await worker.close();
    await app.close();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
