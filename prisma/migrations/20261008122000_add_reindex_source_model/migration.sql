-- Source-model scope for the activation flip (see
-- docs/decisions/0023-embedding-reindex-zero-downtime.md).
--
-- `activate` retags only rows still carrying the model that was active when
-- the job started (plus never-tagged rows that received vectors): without
-- this scope a flip could retag rows owned by a concurrent writer. The
-- column is NULLABLE so pre-existing rows (test-only) need no backfill;
-- `activate` refuses a job with a NULL source instead of guessing.
-- Additive and idempotent (IF NOT EXISTS).

ALTER TABLE "reindex_jobs" ADD COLUMN IF NOT EXISTS "source_model" TEXT;
