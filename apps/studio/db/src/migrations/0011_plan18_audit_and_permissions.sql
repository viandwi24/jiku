-- Plan 18 — Production Hardening
-- 1) Broad audit_logs table (covers auth, secrets, filesystem, members, permissions, tools)
-- 2) Per-member plugin_granted_permissions table

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"    uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "company_id"    uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "actor_id"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_type"    varchar(20) NOT NULL DEFAULT 'user',
  "event_type"    varchar(64) NOT NULL,
  "resource_type" varchar(64) NOT NULL,
  "resource_id"   text,
  "resource_name" text,
  "metadata"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip_address"    varchar(64),
  "user_agent"    text,
  "created_at"    timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "audit_logs_project_idx" ON "audit_logs" ("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_company_idx" ON "audit_logs" ("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx"   ON "audit_logs" ("actor_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_event_idx"   ON "audit_logs" ("event_type", "created_at");

CREATE TABLE IF NOT EXISTS "plugin_granted_permissions" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"    uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "membership_id" uuid NOT NULL REFERENCES "project_memberships"("id") ON DELETE CASCADE,
  "plugin_id"     text NOT NULL,
  "permission"    text NOT NULL,
  "granted_by"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"    timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "plugin_granted_unique" UNIQUE ("membership_id", "plugin_id", "permission")
);

CREATE INDEX IF NOT EXISTS "plugin_granted_project_idx"    ON "plugin_granted_permissions" ("project_id");
CREATE INDEX IF NOT EXISTS "plugin_granted_membership_idx" ON "plugin_granted_permissions" ("membership_id");
