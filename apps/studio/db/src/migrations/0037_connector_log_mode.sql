-- Per-connector inbound logging gate.
-- 'all'                  = log every inbound event/message (legacy behaviour).
-- 'active_binding_only'  = only log when a known binding/target matches
--                          (bot ignores noise from unrelated chats).
ALTER TABLE "connectors"
  ADD COLUMN IF NOT EXISTS "log_mode" text NOT NULL DEFAULT 'all';
