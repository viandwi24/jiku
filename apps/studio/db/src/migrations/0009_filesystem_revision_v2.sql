-- Plan 16-FS-Revision-V2: Filesystem production-scale revision
--
-- This migration adds:
-- 1. New columns on project_files (content_version, cache_valid_until, version, content_hash, name_lower)
-- 2. search_vector TSVECTOR generated column + GIN index (Drizzle lacks native tsvector type)
-- 3. project_folders table (explicit folder tracking, replaces full-scan derivation)
-- 4. storage_cleanup_queue table (deferred S3 delete, tombstone pattern)
-- 5. filesystem_migrations table (async migration tracking)
-- 6. Backfill project_folders from existing project_files data
--
-- All changes are additive — no destructive operations, no downtime required.
-- Existing code continues working without modification.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. project_files — new columns (Drizzle handles most via schema push,
--    but search_vector needs manual SQL because it's a TSVECTOR generated column)
-- ═══════════════════════════════════════════════════════════════════════════

-- search_vector: full-text search using Postgres built-in tsvector (no pg_trgm needed)
-- Generated column — auto-maintained, zero maintenance from app layer.
ALTER TABLE project_files
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(path, ''))
  ) STORED;

-- GIN index on search_vector for fast @@ queries
CREATE INDEX IF NOT EXISTS idx_pfiles_search
  ON project_files USING GIN (search_vector);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Backfill project_folders from existing project_files
-- ═══════════════════════════════════════════════════════════════════════════

-- Extract unique folder_path values from existing files and insert as
-- explicit folder rows. This bridges the gap between the old "virtual folders
-- derived at query time" model and the new "explicit folder table" model.
--
-- parent_path logic:
--   '/src/components' → parent_path = '/src'
--   '/src'            → parent_path = '/'
--   '/'               → parent_path = NULL (root-level, should not appear in files)
--
-- Depth = number of path segments (0 for root-level, 1 for '/src', 2 for '/src/foo')

INSERT INTO project_folders (project_id, path, parent_path, depth)
SELECT DISTINCT
  pf.project_id,
  pf.folder_path AS path,
  CASE
    WHEN pf.folder_path = '/' THEN NULL
    WHEN pf.folder_path NOT LIKE '%/%/%' THEN '/'
    ELSE regexp_replace(pf.folder_path, '/[^/]+$', '')
  END AS parent_path,
  array_length(string_to_array(trim(leading '/' from pf.folder_path), '/'), 1) AS depth
FROM project_files pf
WHERE pf.folder_path IS NOT NULL
  AND pf.folder_path != '/'
ON CONFLICT (project_id, path) DO NOTHING;

-- Also insert intermediate folders that aren't direct folder_path values
-- of any file but are ancestors of deeper paths.
-- Example: file at '/a/b/c/d.ts' has folder_path '/a/b/c', but folders
-- '/a' and '/a/b' might not have any direct files. This ensures they exist.
INSERT INTO project_folders (project_id, path, parent_path, depth)
SELECT DISTINCT
  pf2.project_id,
  sub.ancestor_path AS path,
  CASE
    WHEN sub.ancestor_path NOT LIKE '%/%/%' THEN '/'
    ELSE regexp_replace(sub.ancestor_path, '/[^/]+$', '')
  END AS parent_path,
  array_length(string_to_array(trim(leading '/' from sub.ancestor_path), '/'), 1) AS depth
FROM project_files pf2,
LATERAL (
  SELECT '/' || unnest AS ancestor_path
  FROM (
    SELECT string_agg(part, '/') OVER (ORDER BY ord) AS unnest
    FROM unnest(string_to_array(trim(leading '/' from pf2.path), '/')) WITH ORDINALITY AS parts(part, ord)
    WHERE ord < array_length(string_to_array(trim(leading '/' from pf2.path), '/'), 1)
  ) sub2
) sub
WHERE sub.ancestor_path IS NOT NULL
  AND sub.ancestor_path != ''
ON CONFLICT (project_id, path) DO NOTHING;
