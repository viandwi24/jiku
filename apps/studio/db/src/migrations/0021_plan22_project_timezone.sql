-- Plan 22 revision — per-project default timezone (IANA, e.g. "Asia/Jakarta").
-- DB timestamps remain UTC; this is the fallback when users state local times
-- without a zone. Used by the [Project Context] prompt segment and surfaced in UI.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "default_timezone" text NOT NULL DEFAULT 'UTC';
