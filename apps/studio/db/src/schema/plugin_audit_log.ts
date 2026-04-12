import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { users } from './users.ts'

// Plan 17 — audit every sensitive plugin action (tool invoke, file write, secret access, API call).
export const plugin_audit_log = pgTable('plugin_audit_log', {
  id:         uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  plugin_id:  varchar('plugin_id', { length: 255 }).notNull(),
  user_id:    uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action:     varchar('action', { length: 100 }).notNull(),   // 'tool.invoke' | 'file.write' | 'secret.get' | 'api.call'
  target:     text('target'),                                  // tool id, file path, key...
  outcome:    varchar('outcome', { length: 20 }).notNull(),   // 'ok' | 'denied' | 'error'
  meta:       jsonb('meta'),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('plugin_audit_log_plugin_idx').on(t.plugin_id, t.created_at),
  index('plugin_audit_log_project_idx').on(t.project_id, t.created_at),
])

export type PluginAuditLog = typeof plugin_audit_log.$inferSelect
export type NewPluginAuditLog = typeof plugin_audit_log.$inferInsert
