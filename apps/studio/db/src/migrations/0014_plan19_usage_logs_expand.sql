-- Plan 19 — allow non-agent, non-conversation LLM calls (reflection, dreaming,
-- flush, plugin-invoked, generic custom) to hit usage_logs for cost tracking.

ALTER TABLE "usage_logs"
  ALTER COLUMN "agent_id"        DROP NOT NULL,
  ALTER COLUMN "conversation_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "project_id" uuid
    REFERENCES "projects"("id") ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "source" varchar(64) NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS "duration_ms" integer;

CREATE INDEX IF NOT EXISTS "usage_logs_project_idx"
  ON "usage_logs" ("project_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "usage_logs_source_idx"
  ON "usage_logs" ("source", "created_at" DESC);

-- Backfill project_id for existing rows so cost queries that filter by project
-- work retroactively. Best-effort — rows whose agent was deleted stay NULL.
UPDATE "usage_logs" u
   SET "project_id" = a."project_id"
  FROM "agents" a
 WHERE u."agent_id" = a."id"
   AND u."project_id" IS NULL;
