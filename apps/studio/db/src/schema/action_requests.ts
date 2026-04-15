import { pgTable, uuid, varchar, text, timestamp, jsonb, index, bigserial } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'
import { conversations } from './conversations.ts'
import { users } from './users.ts'

/**
 * Plan 25 — Action Request Center.
 *
 * Unified human-in-the-loop gate. One row per request, polymorphic by `type` (UI shape)
 * and `source_type` / `destination_type` (where decision flows). See plan 25 for full
 * shape conventions of `spec`, `source_ref`, `destination_ref`.
 */
export const action_requests = pgTable('action_requests', {
  id:                uuid('id').primaryKey().defaultRandom(),
  project_id:        uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agent_id:          uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  conversation_id:   uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  task_id:           uuid('task_id').references(() => conversations.id, { onDelete: 'set null' }),

  /** boolean | choice | input | form */
  type:              varchar('type', { length: 20 }).notNull(),
  title:             text('title').notNull(),
  description:       text('description'),
  /** Free-form context shown to operator to help them decide. */
  context:           jsonb('context').notNull().default({}),
  /** Type-specific UI spec (labels, options, validation, fields). */
  spec:              jsonb('spec').notNull().default({}),

  /** outbound_message | agent_tool | task_checkpoint | manual */
  source_type:       varchar('source_type', { length: 32 }).notNull(),
  source_ref:        jsonb('source_ref').notNull().default({}),
  /** outbound_approval | task | task_resume | null */
  destination_type:  varchar('destination_type', { length: 32 }),
  destination_ref:   jsonb('destination_ref'),

  /** pending | approved | rejected | answered | dropped | expired | failed */
  status:            varchar('status', { length: 20 }).notNull().default('pending'),
  response:          jsonb('response'),
  response_by:       uuid('response_by').references(() => users.id, { onDelete: 'set null' }),
  response_at:       timestamp('response_at'),
  expires_at:        timestamp('expires_at'),
  execution_error:   text('execution_error'),

  created_at:        timestamp('created_at').notNull().defaultNow(),
  created_by:        uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updated_at:        timestamp('updated_at').notNull().defaultNow(),
}, t => [
  index('action_requests_project_status').on(t.project_id, t.status, t.created_at),
  index('action_requests_agent').on(t.agent_id, t.created_at),
  index('action_requests_task').on(t.task_id),
  index('action_requests_pending_expires').on(t.expires_at),
])

export type ActionRequestRow = typeof action_requests.$inferSelect
export type NewActionRequestRow = typeof action_requests.$inferInsert

export const action_request_events = pgTable('action_request_events', {
  id:                bigserial('id', { mode: 'number' }).primaryKey(),
  action_request_id: uuid('action_request_id').notNull().references(() => action_requests.id, { onDelete: 'cascade' }),
  event_type:        varchar('event_type', { length: 64 }).notNull(),
  actor_id:          uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actor_type:        varchar('actor_type', { length: 20 }),
  metadata:          jsonb('metadata').notNull().default({}),
  created_at:        timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('action_request_events_ar').on(t.action_request_id, t.created_at),
])

export type ActionRequestEventRow = typeof action_request_events.$inferSelect
export type NewActionRequestEventRow = typeof action_request_events.$inferInsert
