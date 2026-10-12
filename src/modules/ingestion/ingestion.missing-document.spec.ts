import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DocumentExtractorService } from './document-extractor.service.js';
import { IngestionError, IngestionService } from './ingestion.service.js';

/**
 * Missing-document handling in `IngestionService.ingestDocument` (DB stubbed).
 *
 * Regression test for the worker log `Invalid 'prisma.document.update()'...
 * No record was found for an update`: when the document row is gone the
 * service must surface the original failure instead of masking it with a
 * second P2025 from the `FAILED` status update.
 */
describe('IngestionService missing-document handling', () => {
  const documentRow = {
    id: 'doc-gone',
    status: 'PENDING',
    contentHash: 'pending',
    productId: null,
    categoryId: null,
    type: 'MANUAL',
    title: 'Gone manual',
    locale: 'en',
  };

  function setup(options: {
    findUnique: unknown;
    update: ReturnType<typeof vi.fn>;
    embed: ReturnType<typeof vi.fn>;
  }): { service: IngestionService; update: ReturnType<typeof vi.fn> } {
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue(options.findUnique),
        update: options.update,
      },
      chunk: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as PrismaService;
    const service = new IngestionService(
      prisma,
      { model: 'fake-hash-v1', dimensions: 16, embed: options.embed } as never,
      new DocumentExtractorService(),
      {} as AppConfig,
      null,
    );
    return { service, update: options.update };
  }

  it('throws NotFound without a FAILED update when the document never existed', async () => {
    const update = vi.fn();
    const { service } = setup({
      findUnique: null,
      update,
      embed: vi.fn(),
    });
    await expect(
      service.ingestDocument('doc-missing', Buffer.from('# T', 'utf8'), 'text/markdown'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('rethrows the original error when the FAILED update races a delete (P2025)', async () => {
    const p2025 = new PrismaNamespace.PrismaClientKnownRequestError(
      'No record was found for an update.',
      { code: 'P2025', clientVersion: 'test' },
    );
    const update = vi
      .fn()
      .mockResolvedValueOnce({ ...documentRow, status: 'PROCESSING' })
      .mockRejectedValueOnce(p2025);
    const { service } = setup({
      findUnique: documentRow,
      update,
      embed: vi.fn().mockRejectedValue(new IngestionError('embedding boom')),
    });
    await expect(
      service.ingestDocument('doc-gone', Buffer.from('# Gone\n\nBody text here.', 'utf8')),
    ).rejects.toThrow('embedding boom');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[0]).toMatchObject({
      where: { id: 'doc-gone' },
      data: { status: 'FAILED', error: expect.stringContaining('embedding boom') },
    });
  });
});
