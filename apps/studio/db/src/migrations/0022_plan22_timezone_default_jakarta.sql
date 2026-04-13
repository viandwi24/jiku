-- Plan 22 revision — change default project timezone from 'UTC' to 'Asia/Jakarta'.
-- Existing rows are NOT touched (admins can change via Settings → General per project).

ALTER TABLE "projects"
  ALTER COLUMN "default_timezone" SET DEFAULT 'Asia/Jakarta';
