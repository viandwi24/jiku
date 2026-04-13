-- 0027_usage_log_tools_and_adapter.sql
-- Debug aid: record which tools were in the toolset at run time, and which
-- agent adapter executed the run. Helps diagnose cases like "[Cron Delivery]
-- says connector_send exists but model never calls it" — now operator can
-- confirm whether the tool was actually registered when the run happened.

BEGIN;

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS active_tools jsonb,
  ADD COLUMN IF NOT EXISTS agent_adapter varchar(100);

COMMIT;
