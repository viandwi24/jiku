import { pgTable, uuid, varchar, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core'
import { agents } from './agents.ts'
import { users } from './users.ts'

export const conversations = pgTable('conversations', {
  id:                      uuid('id').primaryKey().defaultRandom(),
  agent_id:                uuid('agent_id').references(() => agents.id).notNull(),
  user_id:                 uuid('user_id').references(() => users.id),
  mode:                    varchar('mode', { length: 20 }).notNull().default('chat'),
  title:                   varchar('title', { length: 255 }),
  status:                  varchar('status', { length: 20 }).notNull().default('active'),
  goal:                    text('goal'),
  // Plan 11: conversation type, lifecycle, and task/heartbeat metadata
  type:                    varchar('type', { length: 20 }).notNull().default('chat'),
  metadata:                jsonb('metadata').notNull().default({}),
  caller_id:               uuid('caller_id').references(() => users.id),
  parent_conversation_id:  uuid('parent_conversation_id'),
  run_status:              varchar('run_status', { length: 20 }).notNull().default('idle'),
  started_at:              timestamp('started_at'),
  finished_at:             timestamp('finished_at'),
  error_message:           text('error_message'),
  created_at:              timestamp('created_at').defaultNow(),
  updated_at:              timestamp('updated_at').defaultNow(),
}, (t) => [
  index('idx_conv_agent_type').on(t.agent_id, t.type, t.created_at),
  index('idx_conv_parent').on(t.parent_conversation_id),
  index('idx_conv_run_status').on(t.run_status, t.created_at),
])

export const messages = pgTable('messages', {
  id:              uuid('id').primaryKey().defaultRandom(),
  conversation_id: uuid('conversation_id').references(() => conversations.id).notNull(),
  role:            varchar('role', { length: 20 }).notNull(),
  parts:           jsonb('parts').notNull(),
  created_at:      timestamp('created_at').defaultNow(),
})

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
