-- Backfill `runs:cancel` into Owner/Admin/Manager preset roles. Members and
-- Viewers do NOT get this — cancelling runs is a privileged action because
-- it stops tasks/heartbeats initiated by other users or by cron.
-- Idempotent: only appends if not already present.

UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY['runs:cancel']::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" IN ('Owner', 'Admin', 'Manager');
