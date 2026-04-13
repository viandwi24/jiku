-- Backfill cron_tasks permissions into existing Admin-preset roles.
-- Context: ROLE_PRESETS.admin uses Object.values(PERMISSIONS), which was correct at role creation
-- time, but roles created before cron_tasks:read/write were added to PERMISSIONS still have a stale
-- permissions array. This migration idempotently appends the missing strings so admins regain the
-- Cron Tasks menu + API access without having to recreate their role.

UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY['cron_tasks:read', 'cron_tasks:write']::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" = 'Admin'
  AND NOT ("permissions" @> ARRAY['cron_tasks:read', 'cron_tasks:write']::text[]);
