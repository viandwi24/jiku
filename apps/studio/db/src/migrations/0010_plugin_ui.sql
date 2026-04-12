-- Plan 17 — Plugin UI system.
-- Adds columns to project_plugins and creates plugin_audit_log.
-- NOTE: plugin_storage already exists as `plugin_kv` (scope = plugin_id).

ALTER TABLE "project_plugins"
  ADD COLUMN IF NOT EXISTS "granted_permissions" jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "ui_api_version" varchar(10);

CREATE TABLE IF NOT EXISTS "plugin_audit_log" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "plugin_id"  varchar(255) NOT NULL,
  "user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action"     varchar(100) NOT NULL,
  "target"     text,
  "outcome"    varchar(20) NOT NULL,
  "meta"       jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "plugin_audit_log_plugin_idx"
  ON "plugin_audit_log" ("plugin_id", "created_at");
CREATE INDEX IF NOT EXISTS "plugin_audit_log_project_idx"
  ON "plugin_audit_log" ("project_id", "created_at");
