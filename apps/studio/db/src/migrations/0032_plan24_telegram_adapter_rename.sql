-- Plan 24 Phase 2 — TelegramBotAdapter renamed.
--
-- Adapter id changed from `jiku.telegram` to `jiku.telegram.bot` to free
-- the parent plugin id and let `jiku.telegram.user` (MTProto userbot) live
-- alongside as a separate adapter inside the same plugin.
--
-- This migration updates persisted `connectors.plugin_id` rows. The runtime
-- registry also has an in-memory alias (`ADAPTER_ID_ALIASES`) covering the
-- same redirect for one release cycle as a safety net — that alias may be
-- removed once this migration has been applied to all environments.

UPDATE "connectors"
   SET "plugin_id" = 'jiku.telegram.bot'
 WHERE "plugin_id" = 'jiku.telegram';
