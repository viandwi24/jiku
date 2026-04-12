import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Plan 16 — Deferred S3 object deletion (tombstone pattern).
 *
 * When a file is deleted from the virtual filesystem, the DB row is removed
 * immediately but the S3 object is NOT deleted synchronously. Instead, the
 * storage key is enqueued here and a background worker
 * (`StorageCleanupWorker`) processes entries periodically.
 *
 * This decouples the user-facing operation (fast DB delete) from the
 * potentially slow/flaky S3 delete, and allows retries on transient S3
 * errors without blocking the caller.
 */
export const storage_cleanup_queue = pgTable('storage_cleanup_queue', {
  id:           uuid('id').primaryKey().defaultRandom(),
  storage_key:  text('storage_key').notNull(),
  project_id:   uuid('project_id').notNull(),
  status:       text('status').notNull().default('pending'),  // 'pending' | 'done' | 'failed'
  attempts:     integer('attempts').notNull().default(0),
  last_error:   text('last_error'),
  queued_at:    timestamp('queued_at').defaultNow().notNull(),
  processed_at: timestamp('processed_at'),
}, t => [
  // Partial index — only index pending entries (the only ones the worker queries)
  index('idx_cleanup_pending').on(t.queued_at).where(sql`${t.status} = 'pending'`),
])

export type StorageCleanupEntry = typeof storage_cleanup_queue.$inferSelect
export type NewStorageCleanupEntry = typeof storage_cleanup_queue.$inferInsert
