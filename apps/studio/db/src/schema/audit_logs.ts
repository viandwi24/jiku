import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { companies } from './companies.ts'
import { users } from './users.ts'

// Plan 18 — broad audit log covering auth, secrets, filesystem, members,
// permissions, tool invocations. Extends coverage beyond plugin_audit_log.
export const audit_logs = pgTable('audit_logs', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  company_id:    uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  actor_id:      uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actor_type:    varchar('actor_type', { length: 20 }).notNull().default('user'),
  event_type:    varchar('event_type', { length: 64 }).notNull(),
  resource_type: varchar('resource_type', { length: 64 }).notNull(),
  resource_id:   text('resource_id'),
  resource_name: text('resource_name'),
  metadata:      jsonb('metadata').notNull().default({}),
  ip_address:    varchar('ip_address', { length: 64 }),
  user_agent:    text('user_agent'),
  created_at:    timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('audit_logs_project_idx').on(t.project_id, t.created_at),
  index('audit_logs_company_idx').on(t.company_id, t.created_at),
  index('audit_logs_actor_idx').on(t.actor_id, t.created_at),
  index('audit_logs_event_idx').on(t.event_type, t.created_at),
])

export type AuditLog = typeof audit_logs.$inferSelect
export type NewAuditLog = typeof audit_logs.$inferInsert
