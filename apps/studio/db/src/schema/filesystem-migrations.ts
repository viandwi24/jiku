import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core'

/**
 * Plan 16 — Async filesystem adapter migration tracking.
 *
 * When a user changes the storage credential or adapter (e.g. dev RustFS →
 * production S3), the migration is run as a background job instead of
 * blocking the API request. This table tracks progress so the UI can poll
 * and show a progress bar.
 */
export const filesystem_migrations = pgTable('filesystem_migrations', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  project_id:          uuid('project_id').notNull(),
  from_credential_id:  uuid('from_credential_id'),
  to_credential_id:    uuid('to_credential_id').notNull(),
  status:              text('status').notNull().default('pending'),  // 'pending' | 'in_progress' | 'completed' | 'failed'
  total_files:         integer('total_files'),
  migrated_files:      integer('migrated_files').notNull().default(0),
  failed_files:        integer('failed_files').notNull().default(0),
  error_message:       text('error_message'),
  started_at:          timestamp('started_at'),
  completed_at:        timestamp('completed_at'),
  created_at:          timestamp('created_at').defaultNow().notNull(),
})

export type FilesystemMigration = typeof filesystem_migrations.$inferSelect
export type NewFilesystemMigration = typeof filesystem_migrations.$inferInsert
