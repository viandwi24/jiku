-- Capture the LLM response alongside prompt + messages so the usage log is
-- a complete record of every LLM call (chat, task, title, reflection,
-- dreaming.*, compaction, embedding, plugin:*).
ALTER TABLE "usage_logs"
  ADD COLUMN IF NOT EXISTS "raw_response" varchar DEFAULT null;
