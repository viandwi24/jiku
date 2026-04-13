import { pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, index } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'
import { users } from './users.ts'

export const cron_tasks = pgTable('cron_tasks', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  project_id:            uuid('project_id').references(() => projects.id).notNull(),
  agent_id:              uuid('agent_id').references(() => agents.id).notNull(),
  name:                  varchar('name', { length: 255 }).notNull(),
  description:           text('description'),
  /** Recurring mode: 5-field cron expression. Nullable for 'once' mode. */
  cron_expression:       varchar('cron_expression', { length: 100 }),
  /**
   * Execution mode:
   *  - 'recurring' (default): fires on `cron_expression` indefinitely until disabled/archived.
   *  - 'once': fires exactly once at `run_at`, then auto-archives.
   */
  mode:                  varchar('mode', { length: 20 }).notNull().default('recurring'),
  /** One-shot fire time for `mode === 'once'`. Ignored for recurring. */
  run_at:                timestamp('run_at'),
  prompt:                text('prompt').notNull(),
  /**
   * Plan 22 revision — structured execution context for the cron.
   * Shape: { origin?: { platform, originator_user_id, connector_id, chat_id, scope_key },
   *          delivery?: { connector_id, target_name?, chat_id?, thread_id?, scope_key?, platform? },
   *          subject?: { user_id?, identity_hints? } }
   * Scheduler composes the [Cron Trigger] / [Cron Delivery] prelude from this at fire time.
   * Kept separate from `prompt` so UI prompt edits cannot wipe delivery context.
   */
  context:               jsonb('context').notNull().default({}),
  enabled:               boolean('enabled').notNull().default(true),
  /**
   * Lifecycle state. 'archived' tasks are excluded from default lists and from the
   * scheduler on startup; they remain in the DB so history/audit is preserved.
   */
  status:                varchar('status', { length: 20 }).notNull().default('active'),
  caller_id:             uuid('caller_id').references(() => users.id),
  caller_role:           varchar('caller_role', { length: 100 }),
  caller_is_superadmin:  boolean('caller_is_superadmin').notNull().default(false),
  last_run_at:           timestamp('last_run_at'),
  next_run_at:           timestamp('next_run_at'),
  run_count:             integer('run_count').notNull().default(0),
  metadata:              jsonb('metadata').notNull().default({}),
  created_at:            timestamp('created_at').defaultNow().notNull(),
  updated_at:            timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('cron_tasks_status_idx').on(t.status),
  projectStatusIdx: index('cron_tasks_project_status_idx').on(t.project_id, t.status),
}))

export type CronTask = typeof cron_tasks.$inferSelect
export type NewCronTask = typeof cron_tasks.$inferInsert
