import { UnrecoverableError, type Job } from 'bullmq';
import type { IngestionJobData } from './ingestion.constants.js';
import {
  isMissingDocumentError,
  type IngestResult,
  type IngestionService,
} from './ingestion.service.js';

/**
 * BullMQ processor shared by the standalone worker and tests.
 *
 * Thin by design: it decodes the job payload and delegates to
 * `IngestionService.ingestDocument`, which owns status transitions and
 * idempotency. Thrown errors propagate to BullMQ, which counts the attempt
 * and applies the configured exponential backoff, except for a missing
 * document (stale Redis job after a DB reset, or a concurrent delete),
 * which can never succeed on retry and is mapped to `UnrecoverableError`.
 */
export async function processIngestionJob(
  job: Job<IngestionJobData>,
  service: IngestionService,
): Promise<IngestResult> {
  const raw = Buffer.from(job.data.contentBase64, 'base64');
  try {
    return await service.ingestDocument(job.data.documentId, raw, job.data.contentType);
  } catch (error) {
    if (isMissingDocumentError(error)) {
      throw new UnrecoverableError(`Document ${job.data.documentId} not found, dropping job`);
    }
    throw error;
  }
}
