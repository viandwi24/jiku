import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, unique } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'

/**
 * Plan 24 — Commands system.
 *
 * `project_commands` is a CACHE of FS/plugin command manifests, keyed by
 * (project_id, slug, source). Fields `name`, `description`, `tags`, `entrypoint`,
 * `args_schema` are derived from `manifest` on sync.
 */
export const project_commands = pgTable('project_commands', {
  id:             uuid('id').primaryKey().defaultRandom(),
  project_id:     uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  slug:           varchar('slug', { length: 255 }).notNull(),
  name:           varchar('name', { length: 255 }).notNull(),
  description:    text('description'),
  tags:           text('tags').array().notNull().default([]),
  entrypoint:     text('entrypoint').notNull().default('COMMAND.md'),
  args_schema:    jsonb('args_schema'),
  manifest:       jsonb('manifest'),
  manifest_hash:  varchar('manifest_hash', { length: 64 }),
  source:         varchar('source', { length: 64 }).notNull().default('fs'),
  plugin_id:      varchar('plugin_id', { length: 128 }),
  enabled:        boolean('enabled').notNull().default(true),
  active:         boolean('active').notNull().default(true),
  last_synced_at: timestamp('last_synced_at'),
  created_at:     timestamp('created_at').notNull().defaultNow(),
  updated_at:     timestamp('updated_at').notNull().defaultNow(),
}, t => [unique().on(t.project_id, t.slug, t.source)])

export const agent_commands = pgTable('agent_commands', {
  id:         uuid('id').primaryKey().defaultRandom(),
  agent_id:   uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  command_id: uuid('command_id').notNull().references(() => project_commands.id, { onDelete: 'cascade' }),
  pinned:     boolean('pinned').notNull().default(false),
  created_at: timestamp('created_at').notNull().defaultNow(),
}, t => [unique().on(t.agent_id, t.command_id)])

export type ProjectCommand = typeof project_commands.$inferSelect
export type NewProjectCommand = typeof project_commands.$inferInsert
export type AgentCommand = typeof agent_commands.$inferSelect
export type NewAgentCommand = typeof agent_commands.$inferInsert
