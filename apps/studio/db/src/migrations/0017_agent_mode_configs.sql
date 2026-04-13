-- Plan 21 — per-mode adapter configuration on agents.
ALTER TABLE agents ADD COLUMN mode_configs jsonb NOT NULL DEFAULT '{}';
