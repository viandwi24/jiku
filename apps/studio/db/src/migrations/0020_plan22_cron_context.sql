-- Plan 22 revision — decompose cron storage.
-- Move [Cron Trigger] / [Cron Delivery] blocks from the stored prompt string into
-- a structured jsonb column. Scheduler composes the prelude at fire time, so UI
-- prompt edits cannot wipe delivery context.

ALTER TABLE "cron_tasks"
  ADD COLUMN IF NOT EXISTS "context" jsonb NOT NULL DEFAULT '{}'::jsonb;
