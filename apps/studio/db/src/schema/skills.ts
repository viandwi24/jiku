import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, unique } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'

/**
 * Plan 19 Workstream B — `project_skills` is now a CACHE of FS/plugin skill manifests,
 * not the primary source of truth. Fields `name`, `description`, `tags`, `entrypoint`
 * are derived from `manifest` on sync and should not be edited via UI.
 */
export const project_skills = pgTable('project_skills', {
  id:             uuid('id').primaryKey().defaultRandom(),
  project_id:     uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name:           varchar('name', { length: 255 }).notNull(),
  slug:           varchar('slug', { length: 255 }).notNull(),
  description:    text('description'),
  tags:           text('tags').array().notNull().default([]),
  entrypoint:     text('entrypoint').notNull().default('SKILL.md'),
  enabled:        boolean('enabled').notNull().default(true),
  // Plan 19
  manifest:       jsonb('manifest'),
  manifest_hash:  varchar('manifest_hash', { length: 64 }),
  source:         varchar('source', { length: 64 }).notNull().default('fs'),
  plugin_id:      varchar('plugin_id', { length: 128 }),
  active:         boolean('active').notNull().default(true),
  last_synced_at: timestamp('last_synced_at'),
  created_at:     timestamp('created_at').notNull().defaultNow(),
  updated_at:     timestamp('updated_at').notNull().defaultNow(),
}, t => [unique().on(t.project_id, t.slug, t.source)])

export const agent_skills = pgTable('agent_skills', {
  id:         uuid('id').primaryKey().defaultRandom(),
  agent_id:   uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  skill_id:   uuid('skill_id').notNull().references(() => project_skills.id, { onDelete: 'cascade' }),
  /** 'always' = entrypoint injected into system prompt. 'on_demand' = agent must call skill tools. */
  mode:       varchar('mode', { length: 20 }).notNull().default('on_demand'),
  created_at: timestamp('created_at').notNull().defaultNow(),
}, t => [unique().on(t.agent_id, t.skill_id)])

export type ProjectSkill = typeof project_skills.$inferSelect
export type NewProjectSkill = typeof project_skills.$inferInsert
export type AgentSkill = typeof agent_skills.$inferSelect
export type NewAgentSkill = typeof agent_skills.$inferInsert
