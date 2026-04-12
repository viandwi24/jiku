-- Plan 19 Workstream B — Skills Loader v2
-- 1) project_skills: manifest cache columns + source / plugin_id / active / last_synced_at
-- 2) project_skills unique constraint: (project_id, slug) → (project_id, slug, source)
-- 3) agents: skill_access_mode

ALTER TABLE "project_skills"
  ADD COLUMN IF NOT EXISTS "manifest"       jsonb,
  ADD COLUMN IF NOT EXISTS "manifest_hash"  varchar(64),
  ADD COLUMN IF NOT EXISTS "source"         varchar(64) NOT NULL DEFAULT 'fs',
  ADD COLUMN IF NOT EXISTS "plugin_id"      varchar(128),
  ADD COLUMN IF NOT EXISTS "active"         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp;

-- Bump default entrypoint from legacy 'index.md' to 'SKILL.md' for new rows.
-- Existing rows keep their stored value (backward compat).
ALTER TABLE "project_skills" ALTER COLUMN "entrypoint" SET DEFAULT 'SKILL.md';

DO $$ BEGIN
  ALTER TABLE "project_skills"
    ADD CONSTRAINT "project_skills_source_check"
    CHECK ("source" ~ '^(fs|plugin:.+)$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Replace old unique (project_id, slug) with (project_id, slug, source).
-- Use DO block so it's idempotent across repeated applies.
DO $$
DECLARE
  old_name text;
BEGIN
  SELECT conname INTO old_name
  FROM pg_constraint
  WHERE conrelid = 'public.project_skills'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (project_id, slug)';
  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "project_skills" DROP CONSTRAINT %I', old_name);
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_skills"
    ADD CONSTRAINT "project_skills_project_slug_source_unique"
    UNIQUE ("project_id", "slug", "source");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "project_skills_source_active_idx"
  ON "project_skills" ("project_id", "source", "active");

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "skill_access_mode" varchar(20) NOT NULL DEFAULT 'manual';

DO $$ BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_skill_access_mode_check"
    CHECK ("skill_access_mode" IN ('manual', 'all_on_demand'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
