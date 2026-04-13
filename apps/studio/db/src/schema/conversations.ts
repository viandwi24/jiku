import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, index, type AnyPgColumn } from 'drizzle-orm/pg-core'
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
  // Plan 23: active branch tip — leaf message of the currently-selected branch.
  active_tip_message_id:   uuid('active_tip_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  created_at:              timestamp('created_at').defaultNow(),
  updated_at:              timestamp('updated_at').defaultNow(),
  deleted_at:              timestamp('deleted_at'),
}, (t) => [
  index('idx_conv_agent_type').on(t.agent_id, t.type, t.created_at),
  index('idx_conv_parent').on(t.parent_conversation_id),
  index('idx_conv_run_status').on(t.run_status, t.created_at),
  index('idx_conv_active_tip').on(t.active_tip_message_id),
])

export const messages = pgTable('messages', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  conversation_id:    uuid('conversation_id').references(() => conversations.id).notNull(),
  role:               varchar('role', { length: 20 }).notNull(),
  parts:              jsonb('parts').notNull(),
  // Plan 23: message-level branching.
  parent_message_id:  uuid('parent_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'cascade' }),
  branch_index:       integer('branch_index').notNull().default(0),
  created_at:         timestamp('created_at').defaultNow(),
}, (t) => [
  index('idx_messages_parent').on(t.parent_message_id),
  index('idx_messages_conv_parent').on(t.conversation_id, t.parent_message_id),
])

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
