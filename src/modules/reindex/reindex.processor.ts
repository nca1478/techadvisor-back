import type { Job } from 'bullmq';
import type { ReindexJobData } from './reindex.constants.js';
import type { BatchResult, ReindexService } from './reindex.service.js';

/**
 * BullMQ processor shared by the standalone worker and tests.
 *
 * Thin by design: it forwards the batch to `ReindexService.processBatch`,
 * which owns idempotency (skip chunks already at target) and progress
 * accounting. A wholesale provider failure propagates to BullMQ, which
 * counts the attempt and applies the configured exponential backoff; a
 * retry simply reprocesses the same chunk ids, skipping what is done.
 */
export function processReindexJob(
  job: Job<ReindexJobData>,
  service: ReindexService,
): Promise<BatchResult> {
  return service.processBatch(job.data.reindexJobId, job.data.chunkIds);
}
