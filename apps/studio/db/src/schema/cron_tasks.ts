import { pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'
import { users } from './users.ts'

export const cron_tasks = pgTable('cron_tasks', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  project_id:            uuid('project_id').references(() => projects.id).notNull(),
  agent_id:              uuid('agent_id').references(() => agents.id).notNull(),
  name:                  varchar('name', { length: 255 }).notNull(),
  description:           text('description'),
  cron_expression:       varchar('cron_expression', { length: 100 }).notNull(),
  prompt:                text('prompt').notNull(),
  enabled:               boolean('enabled').notNull().default(true),
  caller_id:             uuid('caller_id').references(() => users.id),
  caller_role:           varchar('caller_role', { length: 100 }),
  caller_is_superadmin:  boolean('caller_is_superadmin').notNull().default(false),
  last_run_at:           timestamp('last_run_at'),
  next_run_at:           timestamp('next_run_at'),
  run_count:             integer('run_count').notNull().default(0),
  metadata:              jsonb('metadata').notNull().default({}),
  created_at:            timestamp('created_at').defaultNow().notNull(),
  updated_at:            timestamp('updated_at').defaultNow().notNull(),
})

export type CronTask = typeof cron_tasks.$inferSelect
export type NewCronTask = typeof cron_tasks.$inferInsert
