-- Migration: Add cron_tasks table and cron_task_enabled to agents

CREATE TABLE IF NOT EXISTS "cron_tasks" (
  "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"           UUID NOT NULL REFERENCES "projects"("id"),
  "agent_id"             UUID NOT NULL REFERENCES "agents"("id"),
  "name"                 VARCHAR(255) NOT NULL,
  "description"          TEXT,
  "cron_expression"      VARCHAR(100) NOT NULL,
  "prompt"               TEXT NOT NULL,
  "enabled"              BOOLEAN NOT NULL DEFAULT TRUE,
  "caller_id"            UUID REFERENCES "users"("id"),
  "caller_role"          VARCHAR(100),
  "caller_is_superadmin" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_run_at"          TIMESTAMP,
  "next_run_at"          TIMESTAMP,
  "run_count"            INTEGER NOT NULL DEFAULT 0,
  "metadata"             JSONB NOT NULL DEFAULT '{}',
  "created_at"           TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cron_task_enabled" BOOLEAN NOT NULL DEFAULT TRUE;
