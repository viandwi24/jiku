-- Plan 22 — Channel System v2: scope_key isolation + named channel targets
-- ADR-056..059

-- Alter: connector_bindings — scope_key_pattern
ALTER TABLE "connector_bindings"
  ADD COLUMN IF NOT EXISTS "scope_key_pattern" text;

-- New: connector_scope_conversations
-- FK names are explicit + shortened so Postgres (63-char limit) doesn't truncate them.
CREATE TABLE IF NOT EXISTS "connector_scope_conversations" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "connector_id"     uuid NOT NULL,
  "scope_key"        text NOT NULL,
  "agent_id"         uuid,
  "conversation_id"  uuid,
  "last_activity_at" timestamp NOT NULL DEFAULT now(),
  "created_at"       timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "fk_scope_conv_connector" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_scope_conv_agent"     FOREIGN KEY ("agent_id")     REFERENCES "agents"("id")     ON DELETE SET NULL,
  CONSTRAINT "fk_scope_conv_conv"      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_scope_conv"
  ON "connector_scope_conversations" ("connector_id", "scope_key", "agent_id");
CREATE INDEX IF NOT EXISTS "idx_scope_conv_connector"
  ON "connector_scope_conversations" ("connector_id", "scope_key");

-- New: connector_targets
CREATE TABLE IF NOT EXISTS "connector_targets" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "connector_id" uuid NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
  "name"         text NOT NULL,
  "display_name" text,
  "description"  text,
  "ref_keys"     jsonb NOT NULL,
  "scope_key"    text,
  "metadata"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "updated_at"   timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_targets_connector_name"
  ON "connector_targets" ("connector_id", "name");
CREATE INDEX IF NOT EXISTS "idx_targets_connector"
  ON "connector_targets" ("connector_id");
