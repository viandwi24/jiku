import { pgTable, uuid, text, integer, timestamp, index, primaryKey } from 'drizzle-orm/pg-core'
import { conversations } from './conversations.ts'

// Session-level file read tracker for Claude-Code-style read-before-write +
// stale-state protection. One row per (conversation, path).
export const conversation_fs_reads = pgTable('conversation_fs_reads', {
  conversation_id: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  path:            text('path').notNull(),
  version:         integer('version').notNull(),
  content_hash:    text('content_hash'),
  read_at:         timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.conversation_id, t.path] }),
  index('idx_fs_reads_read_at').on(t.read_at),
])

export type ConversationFsRead = typeof conversation_fs_reads.$inferSelect
export type NewConversationFsRead = typeof conversation_fs_reads.$inferInsert
