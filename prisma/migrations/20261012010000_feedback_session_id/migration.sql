-- Session link for advisor feedback votes (see docs/decisions/0040-admin-advisor-panel.md).
--
-- Adds a nullable plain `session_id` (no FK, like
-- `unanswered_queries.session_id`) so the admin panel can link a vote to
-- its minimized conversation. Purged sessions leave it dangling and the
-- admin viewer 404s, exactly like unknown ids. Everything here is additive
-- and idempotent (IF NOT EXISTS).

ALTER TABLE "advisor_feedback"
  ADD COLUMN IF NOT EXISTS "session_id" UUID;
