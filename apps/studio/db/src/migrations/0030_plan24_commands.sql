-- Plan 24 — Commands system (user-triggered /slash, FS + plugin, mirrors Skills)

CREATE TABLE IF NOT EXISTS "project_commands" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"     uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "slug"           varchar(255) NOT NULL,
  "name"           varchar(255) NOT NULL,
  "description"    text,
  "tags"           text[] NOT NULL DEFAULT '{}',
  "entrypoint"     text NOT NULL DEFAULT 'COMMAND.md',
  "args_schema"    jsonb,
  "manifest"       jsonb,
  "manifest_hash"  varchar(64),
  "source"         varchar(64) NOT NULL DEFAULT 'fs',
  "plugin_id"      varchar(128),
  "enabled"        boolean NOT NULL DEFAULT true,
  "active"         boolean NOT NULL DEFAULT true,
  "last_synced_at" timestamp,
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "updated_at"     timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "project_commands"
    ADD CONSTRAINT "project_commands_source_check"
    CHECK ("source" ~ '^(fs|plugin:.+)$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_commands"
    ADD CONSTRAINT "project_commands_project_slug_source_unique"
    UNIQUE ("project_id", "slug", "source");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "project_commands_source_active_idx"
  ON "project_commands" ("project_id", "source", "active");

CREATE TABLE IF NOT EXISTS "agent_commands" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "command_id"  uuid NOT NULL REFERENCES "project_commands"("id") ON DELETE CASCADE,
  "pinned"      boolean NOT NULL DEFAULT false,
  "created_at"  timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "agent_commands"
    ADD CONSTRAINT "agent_commands_agent_command_unique"
    UNIQUE ("agent_id", "command_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "command_access_mode" varchar(20) NOT NULL DEFAULT 'manual';

DO $$ BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_command_access_mode_check"
    CHECK ("command_access_mode" IN ('manual', 'all'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
