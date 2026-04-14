-- Custom trigger configuration for connector_bindings.
--
-- Previously trigger_mode had hardcoded semantics:
--   - mention: text.includes('@')         ← matched any @, broken
--   - command: text.startsWith('/')       ← any /command, no whitelist
--   - keyword: substring of trigger_keywords
--   - reply:   (not implemented)
--
-- Now every mode is tunable:
--   - trigger_mention_tokens text[]      → custom tokens (e.g. ['@halo_bot','hai bot']).
--                                          Null/empty = fall back to adapter-detected bot mention.
--   - trigger_commands       text[]      → whitelist of commands without slash (e.g. ['help','ask']).
--                                          Null/empty = any leading "/" passes.
--   - trigger_keywords_regex boolean     → when true, each trigger_keywords entry is compiled
--                                          as a case-insensitive regex instead of substring.

ALTER TABLE "connector_bindings"
  ADD COLUMN IF NOT EXISTS "trigger_mention_tokens" text[],
  ADD COLUMN IF NOT EXISTS "trigger_commands" text[],
  ADD COLUMN IF NOT EXISTS "trigger_keywords_regex" boolean NOT NULL DEFAULT false;
