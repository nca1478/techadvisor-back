import type { JobsOptions } from 'bullmq';

/**
 * Shared ingestion constants (see ADR 0019).
 *
 * Queue topology: the API process only enqueues; the standalone worker
 * (`npm run worker:ingestion`) consumes. Retries are BullMQ-native
 * (`attempts` + exponential `backoff`); after the last attempt the job lands
 * in the failed set and the document stays FAILED, re-runnable via
 * `IngestionService.retryDocument`.
 */

/** BullMQ queue consumed by the ingestion worker. */
export const INGESTION_QUEUE_NAME = 'ingestion';

/** NestJS injection token for the BullMQ `Queue` (typed as `IngestionQueue`). */
export const INGESTION_QUEUE = Symbol('INGESTION_QUEUE');

/** Name of the single job type processed by the ingestion worker. */
export const INGESTION_JOB_NAME = 'ingest-document';

/** Payload of an ingestion job. Content travels base64-encoded. */
export interface IngestionJobData {
  documentId: string;
  /** Raw source bytes (PDF/HTML/Markdown/plain) encoded as base64. */
  contentBase64: string;
  /** Original content type (e.g. `application/pdf`, `text/markdown`). */
  contentType: string;
}

/**
 * Documents travel inside the Redis job payload (no blob store yet): refuse
 * anything larger than this so a giant upload can never poison Redis.
 */
export const MAX_JOB_BYTES = 10 * 1024 * 1024;

/** `documents.source` marker for the product-generated SPEC_SHEET. */
export const AUTO_PRODUCT_SOURCE = 'auto:product';

/** `documents.source` marker for admin-registered documents. */
export const MANUAL_SOURCE = 'manual';

/**
 * Unique provenance for one admin-registered document. Every manual upload or
 * URL registration gets `manual:<documentId>` instead of the bare `manual`
 * marker, so `@@unique([productId, source])` keeps limiting `auto:product`
 * to one row per product (see product-spec-sheet.service.ts) without capping
 * manual documents at one per product (see ADR 0074). Rows created before
 * ADR 0074 keep the legacy bare `manual` value and keep working: nothing
 * filters on `source === 'manual'`.
 */
export function manualDocumentSource(documentId: string): string {
  return `${MANUAL_SOURCE}:${documentId}`;
}

/** Failure detail persisted on `documents.error` is truncated to this. */
export const MAX_ERROR_LENGTH = 500;

/**
 * Interactive-transaction budget for the ingest persist step (delete +
 * createMany + one vector UPDATE per chunk). Multi-page PDFs exceed Prisma's
 * 5s default (remote embedding latency plus sequential UPDATEs), so this
 * step gets a background-scale budget; the payload itself stays bounded by
 * `MAX_JOB_BYTES`. Never used on request-interactive paths.
 */
export const INGESTION_TX_MAX_WAIT_MS = 15_000;
export const INGESTION_TX_TIMEOUT_MS = 120_000;

/**
 * Deterministic BullMQ job id: a document is never queued twice. The
 * separator is `-` because BullMQ rejects custom ids containing `:`.
 */
export function ingestionJobId(documentId: string): string {
  return `ingestion-${documentId}`;
}

export interface IngestionRetryOptions {
  INGESTION_MAX_ATTEMPTS: number;
  INGESTION_BACKOFF_MS: number;
}

/** Default `add()` options: bounded attempts with exponential backoff. */
export function buildIngestionJobOptions(options: IngestionRetryOptions): JobsOptions {
  return {
    attempts: options.INGESTION_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: options.INGESTION_BACKOFF_MS },
    removeOnComplete: 100,
    removeOnFail: 500,
  };
}

// --- Chunking (token estimate: ~4 chars per token) ---------------------------

/** Target chunk size (~400 tokens). */
export const CHUNK_TARGET_CHARS = 1600;

/** Hard chunk size cap (~500 tokens); oversize tables are the only exception. */
export const CHUNK_MAX_CHARS = 2000;

/** Overlap between consecutive chunks (~50 tokens, cut at a word boundary). */
export const CHUNK_OVERLAP_CHARS = 200;

/** Rough token estimate for plain text (used for sizing, never billed). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
