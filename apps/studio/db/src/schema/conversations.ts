import { pgTable, uuid, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { agents } from './agents.ts'
import { users } from './users.ts'

export const conversations = pgTable('conversations', {
  id:         uuid('id').primaryKey().defaultRandom(),
  agent_id:   uuid('agent_id').references(() => agents.id).notNull(),
  user_id:    uuid('user_id').references(() => users.id).notNull(),
  mode:       varchar('mode', { length: 20 }).notNull().default('chat'),
  title:      varchar('title', { length: 255 }),
  status:     varchar('status', { length: 20 }).notNull().default('active'),
  goal:       text('goal'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
})

export const messages = pgTable('messages', {
  id:              uuid('id').primaryKey().defaultRandom(),
  conversation_id: uuid('conversation_id').references(() => conversations.id).notNull(),
  role:            varchar('role', { length: 20 }).notNull(),
  content:         jsonb('content').notNull(),
  created_at:      timestamp('created_at').defaultNow(),
})

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
