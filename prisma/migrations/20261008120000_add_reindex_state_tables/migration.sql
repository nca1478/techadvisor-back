-- Reindex state tables (see docs/decisions/0023-embedding-reindex-zero-downtime.md).
--
-- `rag_embedding_state` holds exactly one row (`key = 'active'`): the model
-- currently serving retrieval. `reindex_jobs` tracks one row per model
-- switch with idempotent progress counters (updated with atomic
-- `SET col = col + $n`, never read-modify-write, so concurrent batch jobs
-- cannot lose increments). Everything here is additive; no existing table,
-- column or index is touched.

-- CreateEnum
CREATE TYPE "ReindexStatus" AS ENUM ('RUNNING', 'COMPLETED');

-- CreateTable
CREATE TABLE "rag_embedding_state" (
    "key" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "column" TEXT NOT NULL,
    "cast" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_embedding_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "reindex_jobs" (
    "id" UUID NOT NULL,
    "target_model" TEXT NOT NULL,
    "target_dim" INTEGER NOT NULL,
    "target_column" TEXT NOT NULL,
    "status" "ReindexStatus" NOT NULL DEFAULT 'RUNNING',
    "total_chunks" INTEGER NOT NULL,
    "processed_chunks" INTEGER NOT NULL DEFAULT 0,
    "failed_chunks" INTEGER NOT NULL DEFAULT 0,
    "batch_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reindex_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reindex_jobs_status_idx" ON "reindex_jobs"("status");
