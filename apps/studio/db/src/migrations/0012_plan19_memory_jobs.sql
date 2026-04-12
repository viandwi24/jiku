-- Plan 19 Workstream A — Memory Evolution foundation
-- 1) agent_memories: memory_type, score_health, source_type
-- 2) background_jobs: durable job queue for reflection / dreaming / flush

ALTER TABLE "agent_memories"
  ADD COLUMN IF NOT EXISTS "memory_type"  varchar(20) NOT NULL DEFAULT 'semantic',
  ADD COLUMN IF NOT EXISTS "score_health" real        NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "source_type"  varchar(20) NOT NULL DEFAULT 'tool';

DO $$ BEGIN
  ALTER TABLE "agent_memories"
    ADD CONSTRAINT "agent_memories_memory_type_check"
    CHECK ("memory_type" IN ('episodic', 'semantic', 'procedural', 'reflective'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agent_memories"
    ADD CONSTRAINT "agent_memories_source_type_check"
    CHECK ("source_type" IN ('tool', 'reflection', 'dream', 'flush'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "agent_memories_type_idx"    ON "agent_memories" ("memory_type");
CREATE INDEX IF NOT EXISTS "agent_memories_health_idx"  ON "agent_memories" ("score_health");

CREATE TABLE IF NOT EXISTS "background_jobs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"            varchar(64) NOT NULL,
  "project_id"      uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "idempotency_key" varchar(255) UNIQUE,
  "payload"         jsonb NOT NULL,
  "status"          varchar(20) NOT NULL DEFAULT 'pending'
                      CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  "attempts"        integer NOT NULL DEFAULT 0,
  "max_attempts"    integer NOT NULL DEFAULT 3,
  "scheduled_at"    timestamp NOT NULL DEFAULT now(),
  "started_at"      timestamp,
  "completed_at"    timestamp,
  "error"           text,
  "created_at"      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "background_jobs_pending_idx" ON "background_jobs" ("status", "scheduled_at")
  WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "background_jobs_project_idx" ON "background_jobs" ("project_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "background_jobs_type_idx"    ON "background_jobs" ("type", "created_at" DESC);
