import { pgTable, uuid, text, varchar, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

/**
 * Plan 16 — Explicit folder tracking for the virtual filesystem.
 *
 * Replaces the O(total_files) `extractImmediateSubfolders()` derivation in
 * `service.list()` with a simple index lookup on `(project_id, parent_path)`.
 * Folders are upserted automatically when files are written, and cleaned up
 * when folders are deleted.
 */
export const project_folders = pgTable('project_folders', {
  id:          uuid('id').primaryKey().defaultRandom(),
  project_id:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path:        text('path').notNull(),         // e.g. '/src/components'
  parent_path: text('parent_path'),            // null for root-level folders (parent = '/')
  depth:       integer('depth').notNull().default(0),
  // Plan 26 — FS tool permission (null = inherit, 'read+write' | 'read')
  tool_permission: varchar('tool_permission', { length: 20 }),
  created_at:  timestamp('created_at').defaultNow().notNull(),
}, t => [
  uniqueIndex('uq_pfolders_project_path').on(t.project_id, t.path),
  index('idx_pfolders_parent').on(t.project_id, t.parent_path),
])

export type ProjectFolder = typeof project_folders.$inferSelect
export type NewProjectFolder = typeof project_folders.$inferInsert
