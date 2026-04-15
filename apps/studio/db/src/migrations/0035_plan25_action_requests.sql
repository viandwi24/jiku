-- Plan 25 — Action Request Center.
-- Unified human-in-the-loop gate that powers outbound approvals, agent-initiated
-- input/approval requests, and task checkpoints. See docs/plans/25-action-request-center.md.

CREATE TABLE IF NOT EXISTS "action_requests" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"            uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "agent_id"              uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "conversation_id"       uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "task_id"               uuid REFERENCES "conversations"("id") ON DELETE SET NULL,

  "type"                  varchar(20) NOT NULL,
  "title"                 text NOT NULL,
  "description"           text,
  "context"               jsonb NOT NULL DEFAULT '{}',
  "spec"                  jsonb NOT NULL DEFAULT '{}',

  "source_type"           varchar(32) NOT NULL,
  "source_ref"            jsonb NOT NULL DEFAULT '{}',
  "destination_type"      varchar(32),
  "destination_ref"       jsonb,

  "status"                varchar(20) NOT NULL DEFAULT 'pending',
  "response"              jsonb,
  "response_by"           uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "response_at"           timestamp,
  "expires_at"            timestamp,
  "execution_error"       text,

  "created_at"            timestamp NOT NULL DEFAULT NOW(),
  "created_by"            uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at"            timestamp NOT NULL DEFAULT NOW(),

  CONSTRAINT "action_requests_type_check"
    CHECK ("type" IN ('boolean','choice','input','form')),
  CONSTRAINT "action_requests_status_check"
    CHECK ("status" IN ('pending','approved','rejected','answered','dropped','expired','failed')),
  CONSTRAINT "action_requests_source_check"
    CHECK ("source_type" IN ('outbound_message','agent_tool','task_checkpoint','manual')),
  CONSTRAINT "action_requests_destination_check"
    CHECK ("destination_type" IS NULL OR "destination_type" IN ('outbound_approval','task','task_resume'))
);

CREATE INDEX IF NOT EXISTS "action_requests_project_status"
  ON "action_requests" ("project_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "action_requests_agent"
  ON "action_requests" ("agent_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "action_requests_task"
  ON "action_requests" ("task_id") WHERE "task_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "action_requests_pending_expires"
  ON "action_requests" ("expires_at") WHERE "status" = 'pending' AND "expires_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "action_request_events" (
  "id"                bigserial PRIMARY KEY,
  "action_request_id" uuid NOT NULL REFERENCES "action_requests"("id") ON DELETE CASCADE,
  "event_type"        varchar(64) NOT NULL,
  "actor_id"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_type"        varchar(20),
  "metadata"          jsonb NOT NULL DEFAULT '{}',
  "created_at"        timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "action_request_events_ar"
  ON "action_request_events" ("action_request_id", "created_at");

-- Backfill new permissions into existing role presets. Idempotent.
UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY['action_requests:read','action_requests:respond','action_requests:write']::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" IN ('Owner', 'Admin', 'Manager');

-- Members get read-only.
UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY['action_requests:read']::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" = 'Member';
