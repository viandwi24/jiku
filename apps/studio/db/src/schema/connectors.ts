import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb, index, uniqueIndex, foreignKey,
} from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'
import { users } from './users.ts'
import { conversations } from './conversations.ts'
import { credentials } from './credentials.ts'

// ─────────────────────────────────────────────────────────────────────────────
// connectors — connector plugin instances per project
// ─────────────────────────────────────────────────────────────────────────────
export const connectors = pgTable('connectors', {
  id:             uuid('id').primaryKey().defaultRandom(),
  project_id:     uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  plugin_id:      text('plugin_id').notNull(),           // 'jiku.telegram'
  display_name:   text('display_name').notNull(),
  credential_id:  uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
  config:         jsonb('config').notNull().default({}), // extra non-secret config (e.g. allowed_chat_ids)
  status:         text('status').notNull().default('inactive'),
  error_message:  text('error_message'),
  created_at:     timestamp('created_at').notNull().defaultNow(),
  updated_at:     timestamp('updated_at').notNull().defaultNow(),
}, t => [
  index('idx_connectors_project').on(t.project_id),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_bindings — routing + trigger rules
// ─────────────────────────────────────────────────────────────────────────────
export const connector_bindings = pgTable('connector_bindings', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  connector_id:         uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  agent_id:             uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  display_name:         text('display_name'),

  // Source filter
  source_type:          text('source_type').notNull().default('any'),
  source_ref_keys:      jsonb('source_ref_keys'),       // null = match all

  // Trigger
  trigger_source:       text('trigger_source').notNull().default('message'),
  trigger_mode:         text('trigger_mode').notNull().default('always'),
  trigger_keywords:     text('trigger_keywords').array(),
  trigger_event_type:   text('trigger_event_type'),
  trigger_event_filter: jsonb('trigger_event_filter'),

  // Adapter type
  adapter_type:         text('adapter_type').notNull().default('conversation'),

  // Security
  require_approval:     boolean('require_approval').notNull().default(false),
  rate_limit_rpm:       integer('rate_limit_rpm'),

  // Context
  context_window:       integer('context_window').notNull().default(10),
  include_sender_info:  boolean('include_sender_info').notNull().default(true),

  enabled:              boolean('enabled').notNull().default(true),
  created_at:           timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_bindings_connector').on(t.connector_id),
  index('idx_bindings_agent').on(t.agent_id),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_identities — external identity → Jiku mapping
// ─────────────────────────────────────────────────────────────────────────────
export const connector_identities = pgTable('connector_identities', {
  id:                uuid('id').primaryKey().defaultRandom(),
  binding_id:        uuid('binding_id').notNull().references(() => connector_bindings.id, { onDelete: 'cascade' }),
  external_ref_keys: jsonb('external_ref_keys').notNull(),  // { user_id: '123', username: '@john' }
  display_name:      text('display_name'),
  avatar_url:        text('avatar_url'),
  status:            text('status').notNull().default('pending'),  // pending | approved | blocked
  approved_by:       uuid('approved_by').references(() => users.id),
  approved_at:       timestamp('approved_at'),
  mapped_user_id:    uuid('mapped_user_id').references(() => users.id),
  conversation_id:   uuid('conversation_id').references(() => conversations.id),
  last_seen_at:      timestamp('last_seen_at'),
  created_at:        timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_identity_binding').on(t.binding_id),
  index('idx_identity_conversation').on(t.conversation_id),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_events — raw event log
// ─────────────────────────────────────────────────────────────────────────────
export const connector_events = pgTable('connector_events', {
  id:              uuid('id').primaryKey().defaultRandom(),
  connector_id:    uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  binding_id:      uuid('binding_id').references(() => connector_bindings.id),
  identity_id:     uuid('identity_id').references(() => connector_identities.id),
  event_type:      text('event_type').notNull(),
  ref_keys:        jsonb('ref_keys').notNull(),
  target_ref_keys: jsonb('target_ref_keys'),
  payload:         jsonb('payload').notNull(),
  metadata:        jsonb('metadata'),
  status:          text('status').notNull().default('received'),
  drop_reason:     text('drop_reason'),
  processing_ms:   integer('processing_ms'),
  created_at:      timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_events_connector').on(t.connector_id, t.created_at),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_messages — inbound/outbound message log
// ─────────────────────────────────────────────────────────────────────────────
export const connector_messages = pgTable('connector_messages', {
  id:               uuid('id').primaryKey().defaultRandom(),
  connector_id:     uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  conversation_id:  uuid('conversation_id').references(() => conversations.id),
  direction:        text('direction').notNull(),  // 'inbound' | 'outbound'
  ref_keys:         jsonb('ref_keys').notNull(),
  content_snapshot: text('content_snapshot'),
  status:           text('status').notNull().default('sent'),
  created_at:       timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_conn_messages_conversation').on(t.conversation_id),
  index('idx_conn_messages_connector').on(t.connector_id, t.created_at),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_message_events — events per connector message (reactions, edits)
// ─────────────────────────────────────────────────────────────────────────────
export const connector_message_events = pgTable('connector_message_events', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  connector_message_id:  uuid('connector_message_id').notNull(),
  connector_event_id:    uuid('connector_event_id'),
  event_type:            text('event_type').notNull(),
  actor_ref_keys:        jsonb('actor_ref_keys'),
  actor_display_name:    text('actor_display_name'),
  payload:               jsonb('payload'),
  created_at:            timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_msg_events_message').on(t.connector_message_id),
  foreignKey({ name: 'fk_cme_message', columns: [t.connector_message_id], foreignColumns: [connector_messages.id] }).onDelete('cascade'),
  foreignKey({ name: 'fk_cme_event',   columns: [t.connector_event_id],   foreignColumns: [connector_events.id] }),
])

// ─────────────────────────────────────────────────────────────────────────────
// user_identities — structured key-value store per user per project
// ─────────────────────────────────────────────────────────────────────────────
export const user_identities = pgTable('user_identities', {
  id:         uuid('id').primaryKey().defaultRandom(),
  user_id:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key:        text('key').notNull(),
  value:      text('value').notNull(),
  label:      text('label'),
  source:     text('source').notNull().default('user'),     // user | agent | system
  visibility: text('visibility').notNull().default('project'), // private | project
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('uq_user_identities_key').on(t.user_id, t.project_id, t.key),
  index('idx_user_identities_project').on(t.project_id, t.key, t.value),
  index('idx_user_identities_user').on(t.user_id, t.project_id),
])
