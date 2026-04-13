-- Plan 22 revision — typing simulation moved from binding to send-action param.
-- This migration originally added `connector_bindings.simulate_typing`. Reverted:
-- the flag now lives on ConnectorContent (each send action decides) so agents
-- can pick per call. If the column was already added, drop it. If not, no-op.

ALTER TABLE "connector_bindings"
  DROP COLUMN IF EXISTS "simulate_typing";
