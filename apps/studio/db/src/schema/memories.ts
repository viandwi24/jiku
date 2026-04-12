import { pgTable, uuid, varchar, text, timestamp, integer, real } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'

export const agent_memories = pgTable('agent_memories', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agent_id:      uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  caller_id:     text('caller_id'),
  scope:         varchar('scope', { length: 50 }).notNull(),
  tier:          varchar('tier', { length: 20 }).notNull().default('extended'),
  section:       varchar('section', { length: 100 }),
  content:       text('content').notNull(),
  importance:    varchar('importance', { length: 20 }).notNull().default('medium'),
  visibility:    varchar('visibility', { length: 50 }).notNull().default('private'),
  source:        varchar('source', { length: 20 }).notNull().default('agent'),
  // Plan 19
  memory_type:   varchar('memory_type', { length: 20 }).notNull().default('semantic'),
  score_health:  real('score_health').notNull().default(1.0),
  source_type:   varchar('source_type', { length: 20 }).notNull().default('tool'),
  access_count:  integer('access_count').notNull().default(0),
  last_accessed: timestamp('last_accessed'),
  expires_at:    timestamp('expires_at'),
  created_at:    timestamp('created_at').notNull().defaultNow(),
  updated_at:    timestamp('updated_at').notNull().defaultNow(),
})

export type AgentMemoryRow = typeof agent_memories.$inferSelect
export type NewAgentMemoryRow = typeof agent_memories.$inferInsert
