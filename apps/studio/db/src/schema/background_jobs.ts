import { pgTable, uuid, varchar, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

/**
 * Plan 19 — Durable background job queue.
 * Consumed by the BackgroundWorker tick loop in apps/studio/server/src/jobs/worker.ts.
 */
export const background_jobs = pgTable('background_jobs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  type:            varchar('type', { length: 64 }).notNull(),
  project_id:      uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  idempotency_key: varchar('idempotency_key', { length: 255 }).unique(),
  payload:         jsonb('payload').notNull(),
  status:          varchar('status', { length: 20 }).notNull().default('pending'),
  attempts:        integer('attempts').notNull().default(0),
  max_attempts:    integer('max_attempts').notNull().default(3),
  scheduled_at:    timestamp('scheduled_at').notNull().defaultNow(),
  started_at:      timestamp('started_at'),
  completed_at:    timestamp('completed_at'),
  error:           text('error'),
  created_at:      timestamp('created_at').notNull().defaultNow(),
})

export type BackgroundJobRow = typeof background_jobs.$inferSelect
export type NewBackgroundJobRow = typeof background_jobs.$inferInsert
