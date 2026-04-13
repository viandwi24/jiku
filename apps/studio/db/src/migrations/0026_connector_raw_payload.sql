-- Add raw_payload column to connector events + messages so the original
-- platform-side JSON (e.g. Telegram update / Telegram sendMessage response)
-- can be inspected from the channels detail drawer.

ALTER TABLE "connector_events"
  ADD COLUMN IF NOT EXISTS "raw_payload" jsonb;

ALTER TABLE "connector_messages"
  ADD COLUMN IF NOT EXISTS "raw_payload" jsonb;

-- Events now have a direction too: 'inbound' (parsed from webhook) or 'outbound'
-- (bot-initiated actions like reactions, edits, deletes, custom adapter actions).
-- Existing rows are inbound by definition.
ALTER TABLE "connector_events"
  ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'inbound';

CREATE INDEX IF NOT EXISTS "idx_events_connector_direction"
  ON "connector_events" ("connector_id", "direction", "created_at");
