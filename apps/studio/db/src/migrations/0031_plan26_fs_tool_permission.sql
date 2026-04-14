-- Plan 26 — FS tool permission via metadata.
-- Per-file + per-folder flag controlling whether agent-facing filesystem tools
-- may write/mutate a path. Inherited from parent folder when null.
--
-- Values:
--   NULL          — inherit from parent (default).
--   'read+write'  — explicit read + write (overrides a stricter parent).
--   'read'        — read-only for tools. Human users editing via the UI are
--                   NOT gated — this only affects fs_write / fs_edit /
--                   fs_append / fs_move / fs_delete / fs_mkdir called from
--                   agent tools.

ALTER TABLE "project_files"
  ADD COLUMN IF NOT EXISTS "tool_permission" varchar(20);

DO $$ BEGIN
  ALTER TABLE "project_files"
    ADD CONSTRAINT "project_files_tool_permission_check"
    CHECK ("tool_permission" IS NULL OR "tool_permission" IN ('read+write', 'read'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "project_folders"
  ADD COLUMN IF NOT EXISTS "tool_permission" varchar(20);

DO $$ BEGIN
  ALTER TABLE "project_folders"
    ADD CONSTRAINT "project_folders_tool_permission_check"
    CHECK ("tool_permission" IS NULL OR "tool_permission" IN ('read+write', 'read'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_pfolders_toolperm"
  ON "project_folders" ("project_id", "path")
  WHERE "tool_permission" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_pfiles_toolperm"
  ON "project_files" ("project_id", "path")
  WHERE "tool_permission" IS NOT NULL;
