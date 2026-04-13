-- 0025_cron_once_and_archive.sql
-- Adds run-once mode and archive status to cron_tasks.
--
-- - mode: 'recurring' (default, current behavior) | 'once' (single-fire then archive)
-- - run_at: one-shot fire time for 'once' mode (ignored for 'recurring')
-- - status: 'active' | 'archived' — archived tasks are hidden from default lists
--
-- cron_expression becomes nullable because 'once' tasks schedule by run_at only.

BEGIN;

ALTER TABLE cron_tasks
  ADD COLUMN IF NOT EXISTS mode varchar(20) NOT NULL DEFAULT 'recurring',
  ADD COLUMN IF NOT EXISTS run_at timestamp,
  ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active';

ALTER TABLE cron_tasks
  ALTER COLUMN cron_expression DROP NOT NULL;

CREATE INDEX IF NOT EXISTS cron_tasks_status_idx ON cron_tasks(status);
CREATE INDEX IF NOT EXISTS cron_tasks_project_status_idx ON cron_tasks(project_id, status);

COMMIT;
