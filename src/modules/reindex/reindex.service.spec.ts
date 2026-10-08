import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeEmbeddingAdapter } from '../ai/adapters/fake-embedding.adapter.js';
import type { EmbeddingStateService } from './embedding-state.service.js';
import { ReindexService, toBatches } from './reindex.service.js';

const TARGET_MODEL = 'fake-16-test';
const TARGET_DIM = 16;

function buildConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    EMBEDDING_MODEL: TARGET_MODEL,
    EMBEDDING_DIM: TARGET_DIM,
    EMBEDDING_BATCH_SIZE: 100,
    INGESTION_MAX_ATTEMPTS: 2,
    INGESTION_BACKOFF_MS: 100,
    ...overrides,
  } as AppConfig;
}

interface MockPrisma {
  ragEmbeddingState: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  reindexJob: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  chunk: { findMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
}

function buildPrisma(): MockPrisma {
  return {
    ragEmbeddingState: { findUnique: vi.fn(), upsert: vi.fn() },
    reindexJob: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    chunk: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
}

function buildService(
  prisma: MockPrisma,
  active: { model: string; dim: number; column: string; cast: string } = {
    model: 'fake-8-test',
    dim: 8,
    column: 'reindex_src_8',
    cast: 'vector',
  },
): { service: ReindexService; providerFor: ReturnType<typeof vi.fn> } {
  const providerFor = vi.fn(
    (model: string, dimensions: number) => new FakeEmbeddingAdapter({ model, dimensions }),
  );
  const state = {
    configuredModel: () => TARGET_MODEL,
    getActive: () => Promise.resolve(active),
    providerFor,
  } as unknown as EmbeddingStateService;
  const service = new ReindexService(
    prisma as unknown as PrismaService,
    state,
    buildConfig(),
    null,
  );
  return { service, providerFor };
}

/** `$queryRaw` mock answering by SQL shape (exists / count / pending / snapshot). */
function mockQueryRaw(
  prisma: MockPrisma,
  opts: {
    snapshotIds?: string[];
    columnExists?: boolean;
    offTarget?: number;
    pending?: Array<{ id: string; content: string }>;
  } = {},
): void {
  const { snapshotIds = [], columnExists = true, offTarget = 0, pending = [] } = opts;
  prisma.$queryRaw = vi.fn((query: { sql?: string }) => {
    const sql = query.sql ?? '';
    if (sql.includes('information_schema')) {
      return Promise.resolve(columnExists ? [{ name: 'embedding_v2' }] : []);
    }
    if (sql.includes('COUNT(*)')) {
      return Promise.resolve([{ count: offTarget }]);
    }
    if (sql.includes('IS NULL')) {
      return Promise.resolve(pending);
    }
    if (sql.includes('FROM "chunks"')) {
      return Promise.resolve(snapshotIds.map((id) => ({ id })));
    }
    return Promise.resolve([]);
  });
  prisma.$executeRaw.mockResolvedValue(1);
}

describe('ReindexService.startReindex', () => {
  it('refuses to start when the target model is already active', async () => {
    const prisma = buildPrisma();
    const { service } = buildService(prisma, {
      model: TARGET_MODEL,
      dim: TARGET_DIM,
      column: 'embedding_v2',
      cast: 'vector',
    });

    await expect(service.startReindex()).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.reindexJob.create).not.toHaveBeenCalled();
  });

  it('fails with the migration SQL when the target column does not exist', async () => {
    const prisma = buildPrisma();
    mockQueryRaw(prisma, { columnExists: false });
    const { service } = buildService(prisma);

    const error = await service.startReindex().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(JSON.stringify(error)).toContain('embedding_v2');
    expect(prisma.reindexJob.create).not.toHaveBeenCalled();
  });

  it('snapshots chunk ids and reports batch counts', async () => {
    const prisma = buildPrisma();
    const ids = Array.from({ length: 250 }, (_, index) => `chunk-${String(index)}`);
    mockQueryRaw(prisma, { snapshotIds: ids });
    prisma.reindexJob.findFirst.mockResolvedValue(null);
    prisma.reindexJob.create = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'job-1', ...args.data }),
    );
    const { service } = buildService(prisma);

    const result = await service.startReindex();

    expect(result).toMatchObject({
      jobId: 'job-1',
      status: 'started',
      sourceModel: 'fake-8-test',
      targetModel: TARGET_MODEL,
      targetDim: TARGET_DIM,
      targetColumn: 'embedding_v2',
      batches: 3,
    });
    expect(result.totalChunks).toBe(250);
    expect(prisma.reindexJob.create).toHaveBeenCalledOnce();
  });

  it('rejoins a RUNNING job for the same target instead of duplicating it', async () => {
    const prisma = buildPrisma();
    mockQueryRaw(prisma);
    prisma.reindexJob.findFirst = vi.fn((args: { where: { targetModel?: string } }) =>
      Promise.resolve(
        args.where.targetModel === TARGET_MODEL
          ? {
              id: 'job-running',
              targetModel: TARGET_MODEL,
              targetDim: TARGET_DIM,
              targetColumn: 'embedding_v2',
              totalChunks: 50,
              batchSize: 100,
            }
          : null,
      ),
    );
    const { service } = buildService(prisma);

    const result = await service.startReindex();

    expect(result).toMatchObject({ jobId: 'job-running', status: 'already-running' });
    expect(prisma.reindexJob.create).not.toHaveBeenCalled();
  });

  it('rejects a different target while another reindex is RUNNING', async () => {
    const prisma = buildPrisma();
    mockQueryRaw(prisma);
    prisma.reindexJob.findFirst = vi.fn((args: { where: { targetModel?: string } }) =>
      Promise.resolve(
        args.where.targetModel === TARGET_MODEL
          ? null
          : { id: 'job-other', targetModel: 'other-model', targetDim: 32 },
      ),
    );
    const { service } = buildService(prisma);

    await expect(service.startReindex()).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ReindexService.processBatch', () => {
  const jobRow = {
    id: 'job-1',
    targetModel: TARGET_MODEL,
    targetDim: TARGET_DIM,
    targetColumn: 'embedding_v2',
    status: 'RUNNING',
  };

  it('skips chunks already carrying a target vector without calling the provider', async () => {
    const prisma = buildPrisma();
    mockQueryRaw(prisma);
    prisma.reindexJob.findUnique.mockResolvedValue(jobRow);
    const { service, providerFor } = buildService(prisma);

    const result = await service.processBatch('job-1', ['a', 'b']);

    expect(result).toEqual({ updated: 0, skipped: 2, failed: 0 });
    expect(providerFor).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('embeds pending chunks and writes only the target column', async () => {
    const prisma = buildPrisma();
    mockQueryRaw(prisma, { pending: [{ id: 'a', content: 'alpha' }] });
    prisma.reindexJob.findUnique.mockResolvedValue(jobRow);
    const { service, providerFor } = buildService(prisma);

    const result = await service.processBatch('job-1', ['a', 'b']);

    expect(result).toEqual({ updated: 1, skipped: 1, failed: 0 });
    expect(providerFor).toHaveBeenCalledWith(TARGET_MODEL, TARGET_DIM);
    const writes = prisma.$executeRaw.mock.calls.map((call) => call[0] as { sql: string });
    const vectorWrite = writes.find((query) => query.sql.includes('SET "embedding_v2"'));
    expect(vectorWrite?.sql).toContain('::vector');
    expect(vectorWrite?.sql).not.toContain('embedding_model');
  });

  it('treats a COMPLETED job as a no-op success (stale redelivery)', async () => {
    const prisma = buildPrisma();
    prisma.reindexJob.findUnique.mockResolvedValue({ ...jobRow, status: 'COMPLETED' });
    const { service } = buildService(prisma);

    await expect(service.processBatch('job-1', ['a'])).resolves.toEqual({
      updated: 0,
      skipped: 1,
      failed: 0,
    });
    expect(prisma.chunk.findMany).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown job', async () => {
    const prisma = buildPrisma();
    prisma.reindexJob.findUnique.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await expect(service.processBatch('missing', ['a'])).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ReindexService.activate', () => {
  const jobRow = {
    id: 'job-1',
    sourceModel: 'fake-8-test',
    targetModel: TARGET_MODEL,
    targetDim: TARGET_DIM,
    targetColumn: 'embedding_v2',
    status: 'COMPLETED',
    totalChunks: 10,
    processedChunks: 10,
    failedChunks: 0,
  };

  function mockCompleted(prisma: MockPrisma, overrides: Record<string, unknown> = {}): void {
    prisma.reindexJob.findUnique.mockResolvedValue({ ...jobRow, ...overrides });
    mockQueryRaw(prisma, { offTarget: 0 });
  }

  it('activates at 100% with zero failures', async () => {
    const prisma = buildPrisma();
    mockCompleted(prisma);
    prisma.ragEmbeddingState.upsert.mockResolvedValue({});
    const { service } = buildService(prisma);

    const result = await service.activate('job-1');

    expect(result).toMatchObject({
      jobId: 'job-1',
      alreadyActive: false,
      model: TARGET_MODEL,
      dim: TARGET_DIM,
      column: 'embedding_v2',
    });
    expect(prisma.ragEmbeddingState.upsert).toHaveBeenCalledOnce();
    // The tag flip retags only rows of the source model, never foreign tags.
    const flip = prisma.$executeRaw.mock.calls
      .map((call) => call[0] as { sql: string })
      .find((query) => query.sql.includes('SET "embedding_model"'));
    expect(flip?.sql).toContain('"embedding_model" = ?');
  });

  it('refuses activation while the job is still RUNNING', async () => {
    const prisma = buildPrisma();
    mockCompleted(prisma, { status: 'RUNNING', processedChunks: 4 });
    const { service } = buildService(prisma);

    await expect(service.activate('job-1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.ragEmbeddingState.upsert).not.toHaveBeenCalled();
  });

  it('refuses activation with failed chunks', async () => {
    const prisma = buildPrisma();
    mockCompleted(prisma, { failedChunks: 2, processedChunks: 8 });
    const { service } = buildService(prisma);

    await expect(service.activate('job-1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.ragEmbeddingState.upsert).not.toHaveBeenCalled();
  });

  it('is idempotent when the target is already active', async () => {
    const prisma = buildPrisma();
    prisma.reindexJob.findUnique.mockResolvedValue(jobRow);
    const { service } = buildService(prisma, {
      model: TARGET_MODEL,
      dim: TARGET_DIM,
      column: 'embedding_v2',
      cast: 'vector',
    });

    const result = await service.activate('job-1');

    expect(result.alreadyActive).toBe(true);
    expect(prisma.ragEmbeddingState.upsert).not.toHaveBeenCalled();
  });
});

describe('toBatches', () => {
  it('splits ids into consecutive batches', () => {
    expect(toBatches(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(toBatches([], 100)).toEqual([]);
  });
});
