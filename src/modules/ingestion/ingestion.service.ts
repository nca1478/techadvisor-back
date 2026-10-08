import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertEmbeddingColumnIdentifier,
  resolveEmbeddingColumnRef,
} from '../reindex/embedding-columns.js';
import { EMBEDDING_PROVIDER } from '../ai/interfaces/embedding-provider.interface.js';
import type { EmbeddingProvider } from '../ai/interfaces/embedding-provider.interface.js';
import { chunkText } from './chunker.js';
import { contentHash } from './content-hash.js';
import { DocumentExtractorService, ExtractionError } from './document-extractor.service.js';
import {
  INGESTION_JOB_NAME,
  INGESTION_QUEUE,
  INGESTION_TX_MAX_WAIT_MS,
  INGESTION_TX_TIMEOUT_MS,
  MAX_ERROR_LENGTH,
  MAX_JOB_BYTES,
  buildIngestionJobOptions,
  ingestionJobId,
} from './ingestion.constants.js';
import type { IngestionQueue } from './ingestion.queue.js';

/**
 * RAG ingestion pipeline (see ADR 0019).
 *
 * `ingestDocument` runs the full pipeline synchronously: extract → clean →
 * hash → (skip when unchanged) → chunk → batched embeddings → transactional
 * persist. The BullMQ worker calls it via `processIngestionJob`; tests and
 * the product hook call it directly. Document rows move
 * `PENDING → PROCESSING → READY | FAILED` with a legible `error` on failure.
 */

export interface IngestResult {
  documentId: string;
  status: 'READY' | 'SKIPPED';
  /** Chunks stored for the document after this run. */
  chunks: number;
}

export interface EnqueueResult {
  enqueued: boolean;
  reason?: 'redis-unavailable' | 'duplicate';
}

export class IngestionError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'IngestionError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly extractor: DocumentExtractorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(INGESTION_QUEUE) private readonly queue?: IngestionQueue | null,
  ) {}

  /**
   * Queues a document for background ingestion. Never throws: when Redis is
   * unreachable the document stays PENDING and the caller (e.g. a product
   * write) is unaffected. `jobId` dedupes: a document is never queued twice.
   */
  async enqueueDocument(
    documentId: string,
    raw: Buffer,
    contentType: string,
  ): Promise<EnqueueResult> {
    if (this.queue === null || this.queue === undefined) {
      return { enqueued: false, reason: 'redis-unavailable' };
    }
    if (raw.length > MAX_JOB_BYTES) {
      throw new IngestionError(
        `Document ${documentId} is too large for the ingestion queue (${String(raw.length)} bytes, max ${String(MAX_JOB_BYTES)})`,
      );
    }
    try {
      await this.queue.add(
        INGESTION_JOB_NAME,
        { documentId, contentBase64: raw.toString('base64'), contentType },
        { ...buildIngestionJobOptions(this.config), jobId: ingestionJobId(documentId) },
      );
      return { enqueued: true };
    } catch (error) {
      if (error instanceof Error && /already exists|duplicate/i.test(error.message)) {
        return { enqueued: false, reason: 'duplicate' };
      }
      this.logger.warn(
        `Could not enqueue ingestion for document ${documentId}: ${this.errorMessage(error)}`,
      );
      return { enqueued: false, reason: 'redis-unavailable' };
    }
  }

  /**
   * Re-runs a FAILED document: back to PENDING plus a fresh queue entry.
   * Only FAILED documents can be retried (READY ones re-ingest via
   * `ingestDocument`, which no-ops when the hash is unchanged).
   */
  async retryDocument(
    documentId: string,
    raw: Buffer,
    contentType: string,
  ): Promise<EnqueueResult> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (document === null) {
      throw new NotFoundException({ message: 'Document not found' });
    }
    if (document.status !== 'FAILED') {
      throw new ConflictException({
        message: `Only FAILED documents can be retried (current status: ${document.status})`,
      });
    }
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'PENDING', error: null },
    });
    return this.enqueueDocument(documentId, raw, contentType);
  }

  /**
   * Runs the ingestion pipeline for a document.
   *
   * Idempotency: a READY document whose hash is unchanged returns
   * `{ status: 'SKIPPED' }` without calling the embedding provider (the
   * document is briefly marked PROCESSING and restored to READY so the
   * `PENDING → PROCESSING → READY | FAILED` lifecycle always holds).
   * Replacement is transactional (delete + insert in one transaction), so a
   * mid-pipeline failure never leaves the document chunkless. Any failure
   * marks the document FAILED with a legible error and rethrows, so BullMQ
   * counts the attempt and backs off.
   */
  async ingestDocument(
    documentId: string,
    raw: Buffer,
    contentType?: string,
  ): Promise<IngestResult> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (document === null) {
      throw new NotFoundException({ message: 'Document not found' });
    }
    const wasReady = document.status === 'READY';
    const previousHash = document.contentHash;

    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING', error: null },
    });

    try {
      const { text } = await this.extractor.extract(raw, contentType);
      const hash = contentHash(text);

      if (wasReady && previousHash === hash) {
        const chunks = await this.prisma.chunk.count({ where: { documentId } });
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: 'READY', error: null },
        });
        return { documentId, status: 'SKIPPED', chunks };
      }
      const chunks = chunkText(text);
      if (chunks.length === 0) {
        throw new IngestionError('Document produced no chunks (no readable text blocks)');
      }
      const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.content));
      if (vectors.length !== chunks.length) {
        throw new IngestionError(
          `Embedding provider returned ${String(vectors.length)} vectors for ${String(chunks.length)} chunks`,
        );
      }
      const { column, cast } = embeddingColumnForIngest(this.embeddings.dimensions);
      const model = this.embeddings.model;
      const dimensions = this.embeddings.dimensions;

      await this.prisma.$transaction(
        async (tx) => {
          await tx.chunk.deleteMany({ where: { documentId } });
          const rows = chunks.map((chunk, index) => ({
            id: randomUUID(),
            documentId,
            productId: document.productId,
            ord: index,
            content: chunk.content,
            locale: document.locale,
            metadata: {
              productId: document.productId,
              categoryId: document.categoryId,
              docType: document.type,
              title: document.title,
              section: chunk.section,
            },
            embeddingModel: model,
            embeddingDim: dimensions,
          }));
          await tx.chunk.createMany({ data: rows });
          // The vector column is resolved from the shared registry (ADR 0023);
          // the identifier is allowlisted before interpolation because column
          // names cannot travel as bound parameters.
          assertEmbeddingColumnIdentifier(column);
          const columnRef = Prisma.raw(`"${column}"`);
          const vectorCast = Prisma.raw(cast);
          for (const [index, row] of rows.entries()) {
            const vector = vectors.at(index);
            if (vector === undefined) {
              throw new IngestionError(`Missing embedding vector for chunk ${String(index)}`);
            }
            const literal = `[${vector.join(',')}]`;
            await tx.$executeRaw(
              Prisma.sql`UPDATE "chunks" SET ${columnRef} = ${literal}::${vectorCast} WHERE "id" = ${row.id}::uuid`,
            );
          }
        },
        { maxWait: INGESTION_TX_MAX_WAIT_MS, timeout: INGESTION_TX_TIMEOUT_MS },
      );

      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'READY', contentHash: hash, error: null },
      });
      return { documentId, status: 'READY', chunks: chunks.length };
    } catch (error) {
      const message = this.errorMessage(error);
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'FAILED', error: message },
      });
      if (error instanceof ExtractionError || error instanceof IngestionError) {
        throw error;
      }
      throw new IngestionError(message, { cause: error });
    }
  }

  /** Legible one-line error for `documents.error` (never content or secrets). */
  private errorMessage(error: unknown): string {
    const raw =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Unknown ingestion failure';
    return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH)}…` : raw;
  }
}

/**
 * Selects the pgvector column matching the configured embedding width.
 * Single source of truth lives in `modules/reindex/embedding-columns.ts`
 * (ADR 0023); this wrapper keeps the historical import path and the
 * `IngestionError` type for write-path failures. Any other width fails
 * loudly — it needs its own column migration plus ADR, never silent mixing.
 */
export function resolveEmbeddingColumn(dimensions: number): string {
  return embeddingColumnForIngest(dimensions).column;
}

function embeddingColumnForIngest(dimensions: number): {
  column: string;
  cast: 'vector' | 'halfvec';
} {
  try {
    return resolveEmbeddingColumnRef(dimensions);
  } catch (error) {
    throw new IngestionError(
      error instanceof Error
        ? error.message
        : `Unsupported embedding dimensions ${String(dimensions)}`,
      { cause: error },
    );
  }
}
