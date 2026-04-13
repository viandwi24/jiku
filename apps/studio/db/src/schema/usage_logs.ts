import { pgTable, uuid, varchar, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { agents } from './agents.ts'
import { conversations } from './conversations.ts'
import { projects } from './projects.ts'
import { users } from './users.ts'

/**
 * Plan 19 — `agent_id` + `conversation_id` are NOT NULL only for traditional
 * chat/task runs. Background LLM calls (reflection, dreaming, flush) and
 * plugin-invoked LLMs attach `project_id` instead and leave agent/conversation
 * nullable. The `source` column disambiguates (`chat` | `reflection` |
 * `dreaming.light` | `dreaming.deep` | `dreaming.rem` | `flush` | `title` |
 * `plugin:<id>` | `custom`).
 */
export const usage_logs = pgTable('usage_logs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  agent_id:        uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  conversation_id: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  project_id:      uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  user_id:         uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  mode:            varchar('mode', { length: 20 }).notNull().default('chat'),
  source:          varchar('source', { length: 64 }).notNull().default('chat'),
  provider_id:     varchar('provider_id', { length: 100 }).default(null),
  model_id:        varchar('model_id', { length: 100 }).default(null),
  input_tokens:    integer('input_tokens').notNull().default(0),
  output_tokens:   integer('output_tokens').notNull().default(0),
  duration_ms:     integer('duration_ms'),
  // Raw data for debug/monitor
  raw_system_prompt: varchar('raw_system_prompt').default(null),
  raw_messages:    jsonb('raw_messages').default(null),
  raw_response:    varchar('raw_response').default(null),
  /** Plan 24 debug — tool names (meta.id) actually registered for this run. Helps diagnose "tool should exist but model didn't call it" cases. */
  active_tools:    jsonb('active_tools'),
  /** Plan 24 debug — agent adapter id that executed the run (e.g. 'jiku.agent.default'). */
  agent_adapter:   varchar('agent_adapter', { length: 100 }),
  created_at:      timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_usage_agent').on(t.agent_id, t.created_at),
  index('idx_usage_conv').on(t.conversation_id),
  index('idx_usage_project').on(t.project_id, t.created_at),
  index('idx_usage_source').on(t.source, t.created_at),
  index('idx_usage_user').on(t.user_id, t.created_at),
])

export type UsageLog = typeof usage_logs.$inferSelect
export type NewUsageLog = typeof usage_logs.$inferInsert
