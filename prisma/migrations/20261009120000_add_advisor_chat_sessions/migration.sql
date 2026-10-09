-- Advisor chat sessions (Fase 4, persistencia del historial; ver
-- docs/decisions/0029-advisor-chat-sessions.md).
--
-- `chat_sessions` holds one conversation per authenticated user (`user_id`)
-- or anonymous guest (`anon_session_id`, the verified guest `sid` uuid from
-- ADR 0010). Exactly one of the two is set (CHECK below); sessions are
-- strictly private (ownership re-checked on every access, cross-user reads
-- 404). `chat_messages` are append-only rows with the message text plus the
-- validated citations/products JSON shown with the answer. Anonymous
-- sessions past the retention window are purged by the cleanup job.
-- Everything here is additive and idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "chat_sessions" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID,
  "anon_session_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chat_sessions_owner_check"
    CHECK (
      ("user_id" IS NOT NULL AND "anon_session_id" IS NULL)
      OR ("user_id" IS NULL AND "anon_session_id" IS NOT NULL)
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_sessions_user_id_fkey'
  ) THEN
    ALTER TABLE "chat_sessions"
      ADD CONSTRAINT "chat_sessions_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "chat_sessions_user_id_idx"
  ON "chat_sessions"("user_id");

CREATE INDEX IF NOT EXISTS "chat_sessions_anon_session_id_idx"
  ON "chat_sessions"("anon_session_id");

CREATE INDEX IF NOT EXISTS "chat_sessions_created_at_idx"
  ON "chat_sessions"("created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChatMessageRole') THEN
    CREATE TYPE "ChatMessageRole" AS ENUM ('USER', 'ASSISTANT');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" UUID NOT NULL,
  "role" "ChatMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "citations" JSONB NOT NULL DEFAULT '[]',
  "products" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_session_id_fkey'
  ) THEN
    ALTER TABLE "chat_messages"
      ADD CONSTRAINT "chat_messages_session_id_fkey"
      FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "chat_messages_session_id_created_at_idx"
  ON "chat_messages"("session_id", "created_at");
