-- Plan 20 — Multi browser profile.
-- Replaces the one-config-per-project shape (projects.browser_enabled +
-- projects.browser_config) with N profiles per project, each choosing an
-- adapter from the BrowserAdapterRegistry (e.g. 'jiku.browser.vercel',
-- 'jiku.camofox'). The legacy columns on `projects` stay in place for
-- safety and will be dropped in a later migration once the UI and API are
-- fully switched over.

CREATE TABLE IF NOT EXISTS "browser_profiles" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"  uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name"        varchar(255) NOT NULL,
  "adapter_id"  varchar(255) NOT NULL,
  "config"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled"     boolean NOT NULL DEFAULT true,
  "is_default"  boolean NOT NULL DEFAULT false,
  "created_at"  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_browser_profiles_project"
  ON "browser_profiles" ("project_id");

-- Only one default profile per project.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_browser_profiles_default"
  ON "browser_profiles" ("project_id")
  WHERE "is_default" = true;

-- Profile names are unique within a project.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_browser_profiles_name"
  ON "browser_profiles" ("project_id", "name");

-- Seed one default profile per project that had browser enabled under the
-- legacy schema, using the existing config.
INSERT INTO "browser_profiles" ("project_id", "name", "adapter_id", "config", "enabled", "is_default")
SELECT
  "id",
  'Default',
  'jiku.browser.vercel',
  COALESCE("browser_config", '{}'::jsonb),
  true,
  true
FROM "projects"
WHERE "browser_enabled" = true
  AND NOT EXISTS (
    SELECT 1 FROM "browser_profiles" bp WHERE bp."project_id" = "projects"."id"
  );
