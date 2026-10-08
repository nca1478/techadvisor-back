import type { Job } from 'bullmq';
import type { IngestionJobData } from './ingestion.constants.js';
import type { IngestResult, IngestionService } from './ingestion.service.js';

/**
 * BullMQ processor shared by the standalone worker and tests.
 *
 * Thin by design: it decodes the job payload and delegates to
 * `IngestionService.ingestDocument`, which owns status transitions and
 * idempotency. Thrown errors propagate to BullMQ, which counts the attempt
 * and applies the configured exponential backoff.
 */
export function processIngestionJob(
  job: Job<IngestionJobData>,
  service: IngestionService,
): Promise<IngestResult> {
  const raw = Buffer.from(job.data.contentBase64, 'base64');
  return service.ingestDocument(job.data.documentId, raw, job.data.contentType);
}
