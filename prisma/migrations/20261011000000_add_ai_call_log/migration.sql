-- AI call observability log (Fase 7, visibilidad operativa; ver
-- docs/decisions/0039-advisor-observability.md).
--
-- `ai_call_logs` holds one metadata-only row per embedding/LLM/retrieval
-- call: type, provider, model, latency, token counts, estimated cost,
-- status, error code and optional session id. It NEVER stores prompts,
-- questions, answers or any user content (no TEXT column for content exists
-- by design). Rows are append-only; the retention cleanup job deletes rows
-- older than `AI_CALL_LOG_RETENTION_DAYS`. Everything here is additive and
-- idempotent (IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AiCallType') THEN
    CREATE TYPE "AiCallType" AS ENUM ('EMBEDDING', 'LLM', 'RETRIEVAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AiCallStatus') THEN
    CREATE TYPE "AiCallStatus" AS ENUM ('OK', 'ERROR');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "ai_call_logs" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" "AiCallType" NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "latency_ms" INTEGER NOT NULL,
  "tokens_in" INTEGER,
  "tokens_out" INTEGER,
  "estimated_cost" DOUBLE PRECISION,
  "status" "AiCallStatus" NOT NULL DEFAULT 'OK',
  "error_code" TEXT,
  "session_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "ai_call_logs_type_provider_model_idx"
  ON "ai_call_logs"("type", "provider", "model");

CREATE INDEX IF NOT EXISTS "ai_call_logs_status_idx"
  ON "ai_call_logs"("status");

CREATE INDEX IF NOT EXISTS "ai_call_logs_created_at_idx"
  ON "ai_call_logs"("created_at");

CREATE INDEX IF NOT EXISTS "ai_call_logs_session_id_idx"
  ON "ai_call_logs"("session_id");
