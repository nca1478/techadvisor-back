import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertEmbeddingColumnIdentifier,
  embeddingColumnDdl,
  resolveEmbeddingColumnRef,
} from './embedding-columns.js';
import { EmbeddingStateService } from './embedding-state.service.js';
import {
  buildReindexJobOptions,
  REINDEX_JOB_NAME,
  REINDEX_QUEUE,
  reindexBatchJobId,
} from './reindex.constants.js';
import type { ReindexQueue } from './reindex.queue.js';

/** Narrow type of the BullMQ queue owned by `ReindexModule` (only `add` is used). */
export type { ReindexQueue };

/** Explicit target override (tests and tooling); the controller uses env. */
export interface StartReindexInput {
  model?: string;
  dimensions?: number;
}

export interface ReindexStartResult {
  jobId: string;
  status: 'started' | 'already-running';
  sourceModel: string;
  targetModel: string;
  targetDim: number;
  targetColumn: string;
  totalChunks: number;
  batches: number;
}

export interface BatchResult {
  updated: number;
  skipped: number;
  failed: number;
}

export interface ReindexProgress {
  jobId: string;
  status: 'RUNNING' | 'COMPLETED';
  sourceModel: string | null;
  targetModel: string;
  targetDim: number;
  targetColumn: string;
  totalChunks: number;
  processedChunks: number;
  failedChunks: number;
  /** 0–100 over the snapshotted set (`processed + failed` over `total`). */
  percent: number;
  /** Live count of chunks still missing vectors in the target column. */
  remainingChunks: number;
  /**
   * True when the snapshotted set is fully accounted for (COMPLETED) with
   * zero failures. `remainingChunks` is intentionally NOT part of the gate:
   * it is a live global count, so transient rows from concurrent writers
   * (tests, mid-reindex ingestion) must never block activation — the gate
   * covers exactly the snapshotted set, and mid-reindex ingestion already
   * writes new-model vectors (see ADR 0023).
   */
  activatable: boolean;
}

export class ReindexError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'ReindexError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Zero-downtime embedding model switching (see ADR 0023).
 *
 * - `startReindex` resolves the target column from `EMBEDDING_MODEL` /
 *   `EMBEDDING_DIM` (the NEW model — the operator updates env first),
 *   snapshots every chunk id, and enqueues one BullMQ job per batch.
 *   Retrieval keeps serving the persisted ACTIVE model throughout.
 * - `processBatch` is idempotent (chunks already at the target model are
 *   skipped) and resumable (a retry or `resume` reprocesses only what is
 *   still off-target), so a crash or a failed batch never corrupts the job.
 * - `activate` flips the persisted active pointer only when the reindex is
 *   provably complete (100% processed, zero failures, zero off-target
 *   chunks live). The previous column is never dropped here.
 */
@Injectable()
export class ReindexService {
  private readonly logger = new Logger(ReindexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: EmbeddingStateService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(REINDEX_QUEUE) private readonly queue?: ReindexQueue | null,
  ) {}

  /**
   * Starts (or idempotently rejoins) the reindex toward the configured new
   * model. Never throws for a missing queue: without Redis the job row and
   * snapshot still exist and batches can run inline via `processBatch`.
   */
  async startReindex(input: StartReindexInput = {}): Promise<ReindexStartResult> {
    const targetModel = input.model ?? this.state.configuredModel();
    const targetDim = input.dimensions ?? this.config.EMBEDDING_DIM;
    if (!Number.isInteger(targetDim) || targetDim < 1 || targetDim > 4000) {
      throw new BadRequestException({
        message: `Target embedding dimensions must be an integer between 1 and 4000, got ${String(targetDim)}`,
      });
    }

    const active = await this.state.getActive();
    if (active.model === targetModel && active.dim === targetDim) {
      throw new ConflictException({
        message: `Model ${targetModel} (${String(targetDim)}d) is already active: update EMBEDDING_MODEL/EMBEDDING_DIM to the new model before starting a reindex`,
      });
    }

    let column: string;
    try {
      ({ column } = resolveEmbeddingColumnRef(targetDim));
    } catch (error) {
      throw new UnprocessableEntityException({
        message: error instanceof Error ? error.message : 'Unsupported target embedding dimensions',
        details: { targetModel, targetDim },
      });
    }
    await this.ensureTargetColumn(column, targetDim);

    const runningSame = await this.prisma.reindexJob.findFirst({
      where: { status: 'RUNNING', targetModel, targetDim },
    });
    if (runningSame !== null) {
      const batches = Math.max(
        1,
        Math.ceil(runningSame.totalChunks / Math.max(1, runningSame.batchSize)),
      );
      return this.toStartResult(runningSame, 'already-running', batches);
    }
    const runningOther = await this.prisma.reindexJob.findFirst({
      where: { status: 'RUNNING' },
    });
    if (runningOther !== null) {
      throw new ConflictException({
        message: `Reindex ${runningOther.id} toward ${runningOther.targetModel} is still RUNNING: wait for it (or let it finish) before switching to ${targetModel}`,
        details: { runningJobId: runningOther.id, targetModel: runningOther.targetModel },
      });
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "chunks" ORDER BY "id"
    `);
    const batchSize = this.config.EMBEDDING_BATCH_SIZE;
    const job = await this.prisma.reindexJob.create({
      data: {
        sourceModel: active.model,
        targetModel,
        targetDim,
        targetColumn: column,
        status: rows.length === 0 ? 'COMPLETED' : 'RUNNING',
        totalChunks: rows.length,
        batchSize,
      },
    });
    const batches = toBatches(
      rows.map((row) => row.id),
      batchSize,
    );
    await this.enqueueBatches(job.id, batches);
    if (rows.length === 0) {
      this.logger.log(`Reindex ${job.id}: empty corpus, marked COMPLETED immediately`);
    } else {
      this.logger.log(
        `Reindex ${job.id}: ${targetModel} (${String(targetDim)}d → ${column}), ${String(rows.length)} chunks in ${String(batches.length)} batches`,
      );
    }
    return this.toStartResult(job, 'started', batches.length);
  }

  /**
   * Processes one batch: embeds every chunk still missing a vector in the
   * target column and writes it, leaving `embedding_model`/`embedding_dim`
   * and the previous column untouched — retrieval keeps serving the old
   * model with zero degradation until the explicit activation flips the
   * tags in one metadata-only UPDATE. Chunks already carrying a target
   * vector (replayed batches, resumed work) and chunks deleted after the
   * snapshot are skipped and counted as processed. A wholesale provider
   * failure propagates so BullMQ counts the attempt and backs off;
   * per-chunk write failures are counted and do not abort the batch.
   */
  async processBatch(reindexJobId: string, chunkIds: string[]): Promise<BatchResult> {
    const job = await this.prisma.reindexJob.findUnique({ where: { id: reindexJobId } });
    if (job === null) {
      throw new NotFoundException({ message: `Reindex job ${reindexJobId} not found` });
    }
    if (job.status !== 'RUNNING') {
      // Stale redelivery after completion: success without side effects.
      return { updated: 0, skipped: chunkIds.length, failed: 0 };
    }
    if (chunkIds.length === 0) {
      return { updated: 0, skipped: 0, failed: 0 };
    }
    assertEmbeddingColumnIdentifier(job.targetColumn);
    const { cast } = resolveEmbeddingColumnRef(job.targetDim);

    const pending = await this.pendingChunks(job.targetColumn, chunkIds);
    const skipped = chunkIds.length - pending.length;

    let vectors: number[][] = [];
    if (pending.length > 0) {
      const provider = this.state.providerFor(job.targetModel, job.targetDim);
      vectors = await provider.embed(
        pending.map((chunk) => chunk.content),
        { kind: 'document' },
      );
      if (vectors.length !== pending.length) {
        throw new ReindexError(
          `Embedding provider returned ${String(vectors.length)} vectors for ${String(pending.length)} chunks`,
        );
      }
    }

    let updated = 0;
    let failed = 0;
    const columnRef = Prisma.raw(`"${job.targetColumn}"`);
    const vectorCast = Prisma.raw(cast);
    for (const [index, chunk] of pending.entries()) {
      const vector = vectors.at(index);
      if (vector === undefined || vector.length !== job.targetDim) {
        failed += 1;
        continue;
      }
      try {
        const literal = `[${vector.join(',')}]`;
        await this.prisma.$executeRaw(
          Prisma.sql`UPDATE "chunks" SET ${columnRef} = ${literal}::${vectorCast} WHERE "id" = ${chunk.id}::uuid`,
        );
        updated += 1;
      } catch (error) {
        this.logger.warn(
          `Reindex ${job.id}: chunk ${chunk.id} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        failed += 1;
      }
    }

    const processed = updated + skipped;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "reindex_jobs"
      SET "processed_chunks" = "processed_chunks" + ${processed}::int,
          "failed_chunks" = "failed_chunks" + ${failed}::int,
          "updated_at" = NOW()
      WHERE "id" = ${job.id}::uuid
    `);
    // Flip to COMPLETED exactly once, when the snapshotted set is fully
    // accounted for (atomic guard: concurrent batches cannot double-flip).
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "reindex_jobs" SET "status" = 'COMPLETED', "updated_at" = NOW()
      WHERE "id" = ${job.id}::uuid AND "status" = 'RUNNING'
        AND ("processed_chunks" + "failed_chunks") >= "total_chunks"
    `);
    return { updated, skipped, failed };
  }

  /** Progress report: snapshot counters plus the live missing-vector count. */
  async getProgress(reindexJobId: string): Promise<ReindexProgress> {
    const job = await this.prisma.reindexJob.findUnique({ where: { id: reindexJobId } });
    if (job === null) {
      throw new NotFoundException({ message: `Reindex job ${reindexJobId} not found` });
    }
    const remainingChunks = await this.countMissingVectors(job.targetColumn);
    const done = job.processedChunks + job.failedChunks;
    const percent =
      job.totalChunks === 0 ? 100 : Math.min(100, Math.round((100 * done) / job.totalChunks));
    return {
      jobId: job.id,
      status: job.status,
      sourceModel: job.sourceModel,
      targetModel: job.targetModel,
      targetDim: job.targetDim,
      targetColumn: job.targetColumn,
      totalChunks: job.totalChunks,
      processedChunks: job.processedChunks,
      failedChunks: job.failedChunks,
      percent,
      remainingChunks,
      activatable: job.status === 'COMPLETED' && job.failedChunks === 0,
    };
  }

  /**
   * Flips retrieval to the target model — only when the snapshotted set is
   * provably fully processed (job COMPLETED, zero failed chunks). The flip
   * itself is a single metadata-only UPDATE retagging those vectors (no
   * re-embedding), followed by the persisted pointer flip — in that order,
   * so a crash between them is repaired by simply running activation again.
   * The previous column is kept (rollback = activate the previous model
   * again after a resume, see ADR 0023).
   */
  async activate(
    reindexJobId: string,
  ): Promise<{
    jobId: string;
    alreadyActive: boolean;
    model: string;
    dim: number;
    column: string;
  }> {
    const job = await this.prisma.reindexJob.findUnique({ where: { id: reindexJobId } });
    if (job === null) {
      throw new NotFoundException({ message: `Reindex job ${reindexJobId} not found` });
    }
    const active = await this.state.getActive();
    if (active.model === job.targetModel && active.dim === job.targetDim) {
      return {
        jobId: job.id,
        alreadyActive: true,
        model: active.model,
        dim: active.dim,
        column: active.column,
      };
    }
    const progress = await this.getProgress(reindexJobId);
    if (progress.status !== 'COMPLETED') {
      throw new ConflictException({
        message: `Reindex ${job.id} is not complete (${String(progress.percent)}%): activation requires 100%`,
        details: { percent: progress.percent },
      });
    }
    if (progress.failedChunks > 0) {
      throw new ConflictException({
        message: `Reindex ${job.id} has ${String(progress.failedChunks)} failed chunks: run resume and fix them before activation`,
        details: { failedChunks: progress.failedChunks },
      });
    }
    assertEmbeddingColumnIdentifier(job.targetColumn);
    if (job.sourceModel === null) {
      throw new UnprocessableEntityException({
        message: `Reindex ${job.id} predates source-model tracking: start a new reindex instead of activating this one`,
      });
    }
    const sourceModel = job.sourceModel;
    const targetRef = Prisma.raw(`"${job.targetColumn}"`);
    // Scoped retag: only rows still carrying the model that was active when
    // the job started (plus never-tagged rows that received vectors) flip.
    // Rows owned by a concurrent writer (another model tag) are never
    // touched, so a shared database cannot cross-contaminate switches.
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "chunks"
      SET "embedding_model" = ${job.targetModel}, "embedding_dim" = ${job.targetDim}
      WHERE ${targetRef} IS NOT NULL
        AND ("embedding_model" = ${sourceModel} OR "embedding_model" IS NULL)
    `);
    const { cast } = resolveEmbeddingColumnRef(job.targetDim);
    await this.prisma.ragEmbeddingState.upsert({
      where: { key: 'active' },
      create: {
        key: 'active',
        model: job.targetModel,
        dim: job.targetDim,
        column: job.targetColumn,
        cast,
      },
      update: { model: job.targetModel, dim: job.targetDim, column: job.targetColumn, cast },
    });
    this.logger.log(
      `Activated embedding model ${job.targetModel} (${String(job.targetDim)}d → ${job.targetColumn})`,
    );
    return {
      jobId: job.id,
      alreadyActive: false,
      model: job.targetModel,
      dim: job.targetDim,
      column: job.targetColumn,
    };
  }

  /**
   * Re-enqueues batches for every chunk still missing a vector in the
   * target column (failed batches, stalled workers, chunks ingested
   * mid-reindex). Chunks already carrying a target vector are skipped
   * idempotently when their batch runs. Safe to call on a COMPLETED job
   * with stragglers: it reopens the job.
   */
  async resume(
    reindexJobId: string,
  ): Promise<{ jobId: string; enqueuedBatches: number; remaining: number }> {
    const job = await this.prisma.reindexJob.findUnique({ where: { id: reindexJobId } });
    if (job === null) {
      throw new NotFoundException({ message: `Reindex job ${reindexJobId} not found` });
    }
    const ids = await this.missingIds(job.targetColumn);
    if (ids.length === 0) {
      return { jobId: job.id, enqueuedBatches: 0, remaining: 0 };
    }
    const batches = toBatches(ids, job.batchSize);
    // Grow the snapshot to cover post-start chunks; failed counters are kept
    // (failed chunks are retried because they still miss the vector).
    const done = job.processedChunks + job.failedChunks;
    await this.prisma.reindexJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', totalChunks: done + ids.length },
    });
    await this.enqueueBatches(job.id, batches);
    this.logger.log(`Reindex ${job.id}: resumed with ${String(ids.length)} chunks`);
    return { jobId: job.id, enqueuedBatches: batches.length, remaining: ids.length };
  }

  /** Chunks of `chunkIds` still missing a vector in `column`. */
  private async pendingChunks(
    column: string,
    chunkIds: string[],
  ): Promise<Array<{ id: string; content: string }>> {
    assertEmbeddingColumnIdentifier(column);
    const columnRef = Prisma.raw(`"${column}"`);
    const idList = Prisma.join(chunkIds.map((id) => Prisma.sql`${id}::uuid`));
    return this.prisma.$queryRaw<Array<{ id: string; content: string }>>(Prisma.sql`
      SELECT "id", "content" FROM "chunks"
      WHERE "id" IN (${idList}) AND ${columnRef} IS NULL
    `);
  }

  /** Live count of chunks still missing a vector in `column`. */
  private async countMissingVectors(column: string): Promise<number> {
    assertEmbeddingColumnIdentifier(column);
    const columnRef = Prisma.raw(`"${column}"`);
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count FROM "chunks" WHERE ${columnRef} IS NULL
    `);
    return rows.at(0)?.count ?? 0;
  }

  private async missingIds(column: string): Promise<string[]> {
    assertEmbeddingColumnIdentifier(column);
    const columnRef = Prisma.raw(`"${column}"`);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "chunks" WHERE ${columnRef} IS NULL ORDER BY "id"
    `);
    return rows.map((row) => row.id);
  }

  /**
   * The target column must exist before any batch runs: it is provisioned
   * by a reviewed additive migration, never by implicit runtime DDL. When
   * it is missing the error carries the exact migration SQL to apply.
   */
  private async ensureTargetColumn(column: string, dimensions: number): Promise<void> {
    assertEmbeddingColumnIdentifier(column);
    const rows = await this.prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chunks' AND column_name = ${column}
    `);
    if (rows.length > 0) {
      return;
    }
    const { cast } = resolveEmbeddingColumnRef(dimensions);
    throw new UnprocessableEntityException({
      message: `Target column "${column}" for ${String(dimensions)} dimensions does not exist: apply an additive migration first (see ADR 0023)`,
      details: { column, dimensions, migrationSql: embeddingColumnDdl(column, dimensions, cast) },
    });
  }

  private async enqueueBatches(reindexJobId: string, batches: string[][]): Promise<void> {
    if (this.queue === null || this.queue === undefined) {
      return;
    }
    for (const [index, chunkIds] of batches.entries()) {
      try {
        await this.queue.add(
          REINDEX_JOB_NAME,
          { reindexJobId, chunkIds },
          { ...buildReindexJobOptions(this.config), jobId: reindexBatchJobId(reindexJobId, index) },
        );
      } catch (error) {
        if (error instanceof Error && /already exists|duplicate/i.test(error.message)) {
          continue;
        }
        // Like ingestion: a queue outage never breaks the API call — batches
        // stay runnable inline via `processBatch` and via `resume`.
        this.logger.warn(
          `Could not enqueue reindex batch ${String(index)} of ${reindexJobId}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }

  private toStartResult(
    job: {
      id: string;
      sourceModel: string | null;
      targetModel: string;
      targetDim: number;
      targetColumn: string;
      totalChunks: number;
    },
    status: 'started' | 'already-running',
    batches: number,
  ): ReindexStartResult {
    return {
      jobId: job.id,
      status,
      sourceModel: job.sourceModel ?? 'unknown',
      targetModel: job.targetModel,
      targetDim: job.targetDim,
      targetColumn: job.targetColumn,
      totalChunks: job.totalChunks,
      batches,
    };
  }
}

/** Splits ids into consecutive batches of at most `size` (pure, unit-tested). */
export function toBatches(ids: string[], size: number): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new ReindexError(`Batch size must be a positive integer, got ${String(size)}`);
  }
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    batches.push(ids.slice(start, start + size));
  }
  return batches;
}
