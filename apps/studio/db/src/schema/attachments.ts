import { pgTable, uuid, varchar, text, timestamp, integer, index, jsonb } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { users } from './users.ts'
import { agents } from './agents.ts'
import { conversations } from './conversations.ts'

// ─── project_attachments ────────────────────────────────────────────────────
// Chat attachments — ephemeral files uploaded alongside chat messages.
// Separate from project_files (Virtual Disk).
//
// S3 key layout: jiku/attachments/{projectId}/{conversationId}/{uuid}.{ext}
// This allows bulk-delete by conversation easily.

export const project_attachments = pgTable('project_attachments', {
  id:              uuid('id').primaryKey().defaultRandom(),
  project_id:      uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agent_id:        uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  conversation_id: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  user_id:         uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** S3 key — permanent, used to generate proxy URL at runtime */
  storage_key:     text('storage_key').notNull(),
  filename:        varchar('filename', { length: 255 }).notNull(),
  mime_type:       varchar('mime_type', { length: 100 }).notNull(),
  size_bytes:      integer('size_bytes').notNull().default(0),
  /** 'per_user' = only the uploading user's conversations can use it. 'shared' = all users in project. */
  scope:           varchar('scope', { length: 20 }).notNull().default('per_user'),
  /** Source type: 'user_upload' | 'browser' | 'connector' | 'plugin' | 'context_write' | 'system' */
  source_type:     varchar('source_type', { length: 30 }).notNull().default('user_upload'),
  /** Arbitrary metadata from the source (e.g., { browser_url, action } for browser, or { connector_id, action_id } for connectors) */
  metadata:        jsonb('metadata').notNull().default({}),
  created_at:      timestamp('created_at').defaultNow().notNull(),
}, t => [
  index('idx_attachments_project').on(t.project_id),
  index('idx_attachments_conversation').on(t.conversation_id),
  index('idx_attachments_user').on(t.project_id, t.user_id),
  index('idx_attachments_source_type').on(t.source_type),
])

export type ProjectAttachment = typeof project_attachments.$inferSelect
export type NewProjectAttachment = typeof project_attachments.$inferInsert
