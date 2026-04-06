import { pgTable, uuid, varchar, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { agents } from './agents.ts'
import { conversations } from './conversations.ts'
import { users } from './users.ts'

export const usage_logs = pgTable('usage_logs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  agent_id:        uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }).notNull(),
  conversation_id: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  user_id:         uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  mode:            varchar('mode', { length: 20 }).notNull().default('chat'),
  provider_id:     varchar('provider_id', { length: 100 }).default(null),
  model_id:        varchar('model_id', { length: 100 }).default(null),
  input_tokens:    integer('input_tokens').notNull().default(0),
  output_tokens:   integer('output_tokens').notNull().default(0),
  // Raw data for debug/monitor
  raw_system_prompt: varchar('raw_system_prompt').default(null),
  raw_messages:    jsonb('raw_messages').default(null),
  created_at:      timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_usage_agent').on(t.agent_id, t.created_at),
  index('idx_usage_conv').on(t.conversation_id),
  index('idx_usage_user').on(t.user_id, t.created_at),
])

export type UsageLog = typeof usage_logs.$inferSelect
export type NewUsageLog = typeof usage_logs.$inferInsert
