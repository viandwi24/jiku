-- 0024_plan23_branch_chat.sql
-- Plan 23: Message-level branching in chat conversations.
--
-- Adds a parent pointer + branch index to messages, and an active-tip
-- pointer to conversations. Backfills existing data as a single linear
-- branch per conversation so current UX is unchanged.

BEGIN;

-- 1. Schema additions ------------------------------------------------------

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS parent_message_id uuid
    REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS branch_index integer NOT NULL DEFAULT 0;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_tip_message_id uuid
    REFERENCES messages(id) ON DELETE SET NULL;

-- 2. Backfill parent_message_id -------------------------------------------
-- Treat existing messages as a single linear branch ordered by created_at.
-- Each message's parent is the previous message in the same conversation.

WITH ordered_msgs AS (
  SELECT
    id,
    LAG(id) OVER (
      PARTITION BY conversation_id
      ORDER BY created_at ASC, id ASC
    ) AS prev_id
  FROM messages
)
UPDATE messages m
SET parent_message_id = o.prev_id
FROM ordered_msgs o
WHERE m.id = o.id
  AND o.prev_id IS NOT NULL
  AND m.parent_message_id IS NULL;

-- 3. Backfill active_tip_message_id to the latest message per conversation

UPDATE conversations c
SET active_tip_message_id = latest.id
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id, id
  FROM messages
  ORDER BY conversation_id, created_at DESC, id DESC
) latest
WHERE c.id = latest.conversation_id
  AND c.active_tip_message_id IS NULL;

-- 4. Indexes ---------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_messages_parent
  ON messages(parent_message_id);

CREATE INDEX IF NOT EXISTS idx_messages_conv_parent
  ON messages(conversation_id, parent_message_id);

CREATE INDEX IF NOT EXISTS idx_conv_active_tip
  ON conversations(active_tip_message_id)
  WHERE active_tip_message_id IS NOT NULL;

COMMIT;
