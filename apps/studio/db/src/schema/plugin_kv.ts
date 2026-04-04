import { pgTable, uuid, varchar, text, timestamp, index, unique } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

export const plugin_kv = pgTable('plugin_kv', {
  id:         uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  scope:      varchar('scope', { length: 255 }).notNull(),   // plugin_id
  key:        varchar('key', { length: 255 }).notNull(),
  value:      text('value').notNull(),                       // JSON-serialized
  updated_at: timestamp('updated_at').defaultNow(),
}, (t) => [
  unique('plugin_kv_unique').on(t.project_id, t.scope, t.key),
  index('plugin_kv_project_scope_idx').on(t.project_id, t.scope),
])

export type PluginKv = typeof plugin_kv.$inferSelect
export type NewPluginKv = typeof plugin_kv.$inferInsert
