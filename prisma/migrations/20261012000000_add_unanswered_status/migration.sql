-- Triage status for advisor abstentions (see docs/decisions/0040-admin-advisor-panel.md).
--
-- Adds a plain TEXT `status` column (`NEW` | `IN_REVIEW` | `RESOLVED`,
-- validated at the API edge) defaulting to `NEW`, so the admin panel can
-- track the improvement loop without touching the recorded question.
-- Everything here is additive and idempotent (IF NOT EXISTS).

ALTER TABLE "unanswered_queries"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'NEW';

CREATE INDEX IF NOT EXISTS "unanswered_queries_status_idx"
  ON "unanswered_queries"("status");
