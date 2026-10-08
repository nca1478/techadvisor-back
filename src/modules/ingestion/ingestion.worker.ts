import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from '../../app.module.js';
import { parseEnv } from '../../config/env.schema.js';
import { INGESTION_QUEUE_NAME, type IngestionJobData } from './ingestion.constants.js';
import { processIngestionJob } from './ingestion.processor.js';
import { IngestionService } from './ingestion.service.js';
import { parseRedisConnection } from './ingestion.queue.js';

/**
 * Standalone ingestion worker entrypoint (`npm run worker:ingestion`).
 *
 * Topology choice (see ADR 0019): the API process only enqueues while this
 * separate process consumes the `ingestion` queue, so a poison document or
 * an embedding outage can never block HTTP and both sides scale
 * independently. The worker shares the full application context (same
 * services, same config) — `createApplicationContext` boots no HTTP server.
 * Run from compiled output (`npm run build && npm run worker:ingestion`):
 * direct `tsx` loading hits a pre-existing native-ESM cycle in the auth
 * modules (see ADR 0019).
 */
async function bootstrap(): Promise<void> {
  const config = parseEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  const ingestion = app.get(IngestionService);

  const worker = new Worker<IngestionJobData>(
    INGESTION_QUEUE_NAME,
    (job) => processIngestionJob(job, ingestion),
    {
      connection: { ...parseRedisConnection(config.REDIS_URL), maxRetriesPerRequest: null },
      concurrency: config.INGESTION_CONCURRENCY,
    },
  );
  worker.on('failed', (job, error) => {
    // Document rows already carry the legible error (see IngestionService);
    // this log keeps the job id visible for operations.
    console.error(`Ingestion job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  });
  console.log(
    `Ingestion worker listening on queue "${INGESTION_QUEUE_NAME}" (concurrency ${String(config.INGESTION_CONCURRENCY)})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Ingestion worker received ${signal}, closing...`);
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
