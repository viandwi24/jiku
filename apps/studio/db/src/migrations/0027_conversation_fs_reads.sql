-- Session-level file read tracker. Records the version of each file that the
-- agent read in a conversation so fs_write / fs_edit can enforce
-- read-before-write and detect external modifications (stale state).
--
-- One row per (conversation, path). Upserted on fs_read; consulted on
-- fs_write / fs_edit. Cascade on conversation delete.

CREATE TABLE IF NOT EXISTS "conversation_fs_reads" (
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "path"            text NOT NULL,
  "version"         integer NOT NULL,
  "content_hash"    text,
  "read_at"         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "path")
);

CREATE INDEX IF NOT EXISTS "idx_fs_reads_read_at" ON "conversation_fs_reads" ("read_at");
