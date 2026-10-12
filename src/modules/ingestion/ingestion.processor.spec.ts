import { NotFoundException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import type { Job } from 'bullmq';
import type { IngestionJobData } from './ingestion.constants.js';
import { processIngestionJob } from './ingestion.processor.js';
import { IngestionError, type IngestionService } from './ingestion.service.js';

/**
 * Processor error mapping (no Redis, no DB).
 *
 * A missing document (stale Redis job after a DB reset, or a concurrent
 * delete) can never succeed on retry, so it must become BullMQ's
 * `UnrecoverableError`; any other failure keeps its original error so the
 * configured attempts + exponential backoff still apply.
 */
describe('processIngestionJob', () => {
  const job = {
    data: {
      documentId: 'doc-missing',
      contentBase64: Buffer.from('# Title', 'utf8').toString('base64'),
      contentType: 'text/markdown',
    },
  } as Job<IngestionJobData>;

  function serviceWith(failure: unknown): IngestionService {
    return {
      ingestDocument:
        failure === null
          ? vi.fn().mockResolvedValue({ documentId: 'doc-missing', status: 'READY', chunks: 2 })
          : vi.fn().mockRejectedValue(failure),
    } as unknown as IngestionService;
  }

  it('passes through a successful ingestion', async () => {
    const result = await processIngestionJob(job, serviceWith(null));
    expect(result).toEqual({ documentId: 'doc-missing', status: 'READY', chunks: 2 });
  });

  it('maps NotFoundException to UnrecoverableError (no retry)', async () => {
    const service = serviceWith(new NotFoundException({ message: 'Document not found' }));
    const failure = await processIngestionJob(job, service).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UnrecoverableError);
  });

  it('maps Prisma P2025 (row deleted mid-flight) to UnrecoverableError', async () => {
    const p2025 = new PrismaNamespace.PrismaClientKnownRequestError(
      'No record was found for an update.',
      { code: 'P2025', clientVersion: 'test' },
    );
    const service = serviceWith(p2025);
    const failure = await processIngestionJob(job, service).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows any other error unchanged so BullMQ retries', async () => {
    const original = new IngestionError('embedding boom');
    const service = serviceWith(original);
    const failure = await processIngestionJob(job, service).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBe(original);
  });
});
