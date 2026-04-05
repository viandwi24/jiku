import { pgTable, uuid, varchar, text, timestamp, unique, integer, jsonb, index } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

export const agents = pgTable('agents', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  project_id:           uuid('project_id').references(() => projects.id).notNull(),
  name:                 varchar('name', { length: 255 }).notNull(),
  slug:                 varchar('slug', { length: 255 }).notNull(),
  description:          text('description'),
  base_prompt:          text('base_prompt').notNull(),
  allowed_modes:        text('allowed_modes').array().notNull().default(['chat']),
  /** Context compaction threshold (0–100%). 0 = disabled. Default 80. */
  compaction_threshold: integer('compaction_threshold').default(80).notNull(),
  /** Partial memory config override (null = inherit all from project). */
  memory_config:        jsonb('memory_config').default(null),
  /** Initial persona seed (name, role, personality, etc). Applied once when agent_self is empty. */
  persona_seed:         jsonb('persona_seed').default(null),
  /** Timestamp when persona seed was applied. null = not yet seeded. */
  persona_seeded_at:    timestamp('persona_seeded_at'),
  created_at:           timestamp('created_at').defaultNow(),
}, t => [unique().on(t.project_id, t.slug)])

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
