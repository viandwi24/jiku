import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, unique } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

// Plugin registry — all available plugins (synced from server on boot)
export const plugins = pgTable('plugins', {
  id:           varchar('id', { length: 255 }).primaryKey(),  // 'jiku.cron'
  name:         varchar('name', { length: 255 }).notNull(),
  description:  text('description'),
  version:      varchar('version', { length: 50 }).notNull(),
  author:       varchar('author', { length: 255 }),
  icon:         varchar('icon', { length: 255 }),
  category:     varchar('category', { length: 100 }),
  project_scope: boolean('project_scope').default(false),
  // JSON Schema generated from zodToJsonSchema(plugin.configSchema)
  config_schema: jsonb('config_schema').default({}),
  created_at:   timestamp('created_at').defaultNow(),
  updated_at:   timestamp('updated_at').defaultNow(),
})

// Project plugin activation — which plugins are enabled per project
export const project_plugins = pgTable('project_plugins', {
  id:           uuid('id').primaryKey().defaultRandom(),
  project_id:   uuid('project_id').references(() => projects.id).notNull(),
  plugin_id:    varchar('plugin_id', { length: 255 }).references(() => plugins.id).notNull(),
  enabled:      boolean('enabled').default(false),
  // Config validated by configSchema
  config:       jsonb('config').default({}),
  activated_at: timestamp('activated_at'),
  updated_at:   timestamp('updated_at').defaultNow(),
}, t => [unique().on(t.project_id, t.plugin_id)])

export type Plugin = typeof plugins.$inferSelect
export type NewPlugin = typeof plugins.$inferInsert
export type ProjectPlugin = typeof project_plugins.$inferSelect
export type NewProjectPlugin = typeof project_plugins.$inferInsert
