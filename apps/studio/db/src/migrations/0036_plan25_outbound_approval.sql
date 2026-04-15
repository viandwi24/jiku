-- Plan 25 Phase 4 — outbound_approval config on connectors.
-- Adds a JSONB column controlling whether outbound `connector_send` calls go
-- through the Action Request Center. Default {"mode":"none"} preserves legacy
-- behavior (direct send, no approval).
--
-- Shape: { "mode": "none" | "always" | "tagged", "default_expires_in_seconds"?: number }

ALTER TABLE "connectors"
  ADD COLUMN IF NOT EXISTS "outbound_approval" jsonb NOT NULL DEFAULT '{"mode":"none"}';
