-- Backfill new permission keys into existing Admin + Manager preset roles so
-- owners of existing projects regain access to Skills / Commands / Browser /
-- Disk / Usage / Console menus + APIs without having to recreate their roles.
--
-- Idempotent: only appends permission strings that aren't already present.
-- Mirrors the pattern of 0019_plan22_backfill_admin_cron_perms.sql.

UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY[
      'skills:read', 'skills:write',
      'commands:read', 'commands:write',
      'browser:read', 'browser:write',
      'disk:read', 'disk:write',
      'usage:read',
      'console:read'
    ]::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" IN ('Admin', 'Owner');

-- Manager: read + write for team operations; Member: read-only for most.
UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY[
      'skills:read', 'skills:write',
      'commands:read', 'commands:write',
      'browser:read', 'browser:write',
      'disk:read', 'disk:write',
      'usage:read',
      'console:read'
    ]::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" = 'Manager';

UPDATE "project_roles"
SET "permissions" = array_cat(
  "permissions",
  ARRAY(
    SELECT p FROM unnest(ARRAY[
      'skills:read',
      'commands:read',
      'disk:read',
      'console:read'
    ]::text[]) AS p
    WHERE p <> ALL("permissions")
  )
)
WHERE "name" = 'Member';
