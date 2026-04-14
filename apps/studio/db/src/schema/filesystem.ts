import { pgTable, uuid, varchar, text, timestamp, boolean, integer, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { projects } from './projects.ts'
import { users } from './users.ts'

// ─── project_filesystem_config ─────────────────────────────────────────────
// One row per project. Created lazily on first PATCH.

export const project_filesystem_config = pgTable('project_filesystem_config', {
  id:               uuid('id').primaryKey().defaultRandom(),
  project_id:       uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  adapter_id:       varchar('adapter_id', { length: 50 }).notNull().default('s3'),
  credential_id:    uuid('credential_id'), // references credentials(id) — no FK to avoid circular dep
  enabled:          boolean('enabled').notNull().default(false),
  total_files:      integer('total_files').notNull().default(0),
  total_size_bytes: bigint('total_size_bytes', { mode: 'number' }).notNull().default(0),
  created_at:       timestamp('created_at').defaultNow().notNull(),
  updated_at:       timestamp('updated_at').defaultNow().notNull(),
})

// ─── project_files ──────────────────────────────────────────────────────────

export const project_files = pgTable('project_files', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path:          text('path').notNull(),          // '/src/index.ts'
  name:          varchar('name', { length: 255 }).notNull(), // 'index.ts'
  folder_path:   text('folder_path').notNull(),   // '/src'
  extension:     varchar('extension', { length: 50 }).notNull(), // '.ts'
  storage_key:   text('storage_key').notNull(),   // key in storage backend
  size_bytes:    integer('size_bytes').notNull().default(0),
  mime_type:     varchar('mime_type', { length: 100 }).notNull().default('text/plain'),
  content_cache: text('content_cache'),           // null if file > 50 KB

  // Plan 16 — cache invalidation + optimistic locking
  content_version:   integer('content_version').notNull().default(1),
  cache_valid_until: timestamp('cache_valid_until'),
  version:           integer('version').notNull().default(1),
  content_hash:      text('content_hash'),         // SHA-256, for dedup check

  // Plan 16 — search optimization (generated column, auto-maintained by Postgres)
  // NOTE: search_vector (TSVECTOR) + GIN index are added via manual migration SQL
  // because Drizzle lacks a native tsvector column type. See migration file.
  name_lower:        text('name_lower').generatedAlwaysAs(
    sql`lower(${sql.raw('name')})`,
  ),

  // Plan 26 — FS tool permission (null = inherit, 'read+write' | 'read')
  tool_permission: varchar('tool_permission', { length: 20 }),

  created_by:    uuid('created_by').references(() => users.id),
  updated_by:    uuid('updated_by').references(() => users.id),
  created_at:    timestamp('created_at').defaultNow().notNull(),
  updated_at:    timestamp('updated_at').defaultNow().notNull(),
}, t => [
  index('idx_files_project').on(t.project_id),
  index('idx_files_folder').on(t.project_id, t.folder_path),
  index('idx_files_extension').on(t.project_id, t.extension),
  index('idx_files_updated').on(t.project_id, t.updated_at),
  index('idx_files_name_lower').on(t.project_id, t.name_lower),
  uniqueIndex('uq_files_project_path').on(t.project_id, t.path),
])

export type ProjectFilesystemConfig = typeof project_filesystem_config.$inferSelect
export type NewProjectFilesystemConfig = typeof project_filesystem_config.$inferInsert
export type ProjectFile = typeof project_files.$inferSelect
export type NewProjectFile = typeof project_files.$inferInsert
