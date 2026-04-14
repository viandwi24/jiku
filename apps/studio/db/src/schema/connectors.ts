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
  /** Match mode: 'all' = execute all matching bindings, 'first' = first match wins (by priority). */
  match_mode:     text('match_mode').notNull().default('all'),
  /** Fallback agent when no binding matches. Null = no fallback (current behavior). */
  default_agent_id: uuid('default_agent_id').references(() => agents.id, { onDelete: 'set null' }),
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
  display_name:         text('display_name'),

  // ── Input ────────────────────────────────────────────────────────────────
  source_type:          text('source_type').notNull().default('any'),  // any | private | group | channel
  source_ref_keys:      jsonb('source_ref_keys'),                       // null = match all

  trigger_source:       text('trigger_source').notNull().default('message'),  // message | event
  trigger_mode:         text('trigger_mode').notNull().default('always'),     // always | mention | reply | command | keyword
  trigger_keywords:     text('trigger_keywords').array(),
  // When true, each trigger_keywords entry is compiled as a case-insensitive regex.
  trigger_keywords_regex: boolean('trigger_keywords_regex').notNull().default(false),
  // Custom tokens for trigger_mode='mention' (e.g. ['@halo_bot','hai bot']).
  // Null/empty = fall back to adapter-detected mention (event.metadata.bot_mentioned).
  trigger_mention_tokens: text('trigger_mention_tokens').array(),
  // Whitelist for trigger_mode='command' WITHOUT the leading slash
  // (e.g. ['help','ask','start']). Null/empty = any "/cmd" passes.
  trigger_commands:     text('trigger_commands').array(),
  trigger_event_type:   text('trigger_event_type'),
  trigger_event_filter: jsonb('trigger_event_filter'),

  // ── Output ───────────────────────────────────────────────────────────────
  // output_adapter: which output adapter to use (conversation | task | <plugin-defined>)
  output_adapter:       text('output_adapter').notNull().default('conversation'),
  // output_config: adapter-specific config (e.g. { agent_id, conversation_mode } for conversation)
  output_config:        jsonb('output_config').notNull().default({}),

  // ── Routing (Plan 15.5) ───────────────────────────────────────────────────
  /** Higher priority wins when multiple bindings match. Default 0. */
  priority:             integer('priority').notNull().default(0),
  /** Regex pattern matched against message text. Null = no regex check. */
  trigger_regex:        text('trigger_regex'),
  /** Schedule filter: only match during certain hours. JSON: AvailabilitySchedule shape. */
  schedule_filter:      jsonb('schedule_filter'),

  // ── Security ─────────────────────────────────────────────────────────────
  rate_limit_rpm:       integer('rate_limit_rpm'),
  include_sender_info:  boolean('include_sender_info').notNull().default(true),

  // ── Scope filter (Plan 22) ───────────────────────────────────────────────
  /** Scope key pattern, e.g. null = all, "group:*" = group chats only, "dm:*" = DMs, exact = specific scope. */
  scope_key_pattern:    text('scope_key_pattern'),

  /**
   * Group/channel member admission gate (2026-04-14).
   * 'require_approval' = new members' first message creates a pending identity
   * pairing request; admin must approve before the agent responds.
   * 'allow_all' = any member in the scope can trigger the agent immediately.
   * Ignored for DM (source_type='private') bindings — those are already
   * single-user via source_ref_keys.user_id.
   */
  member_mode:          text('member_mode').notNull().default('require_approval'),

  enabled:              boolean('enabled').notNull().default(true),
  created_at:           timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_bindings_connector').on(t.connector_id),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_scope_conversations — scope-scoped conversation mapping (Plan 22)
// One row per (connector, scope_key, agent_id). Null scope = DM (uses identity.conversation_id).
// ─────────────────────────────────────────────────────────────────────────────
export const connector_scope_conversations = pgTable('connector_scope_conversations', {
  id:               uuid('id').primaryKey().defaultRandom(),
  connector_id:     uuid('connector_id').notNull(),
  scope_key:        text('scope_key').notNull(),
  agent_id:         uuid('agent_id'),
  conversation_id:  uuid('conversation_id'),
  last_activity_at: timestamp('last_activity_at').notNull().defaultNow(),
  created_at:       timestamp('created_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('uq_scope_conv').on(t.connector_id, t.scope_key, t.agent_id),
  index('idx_scope_conv_connector').on(t.connector_id, t.scope_key),
  foreignKey({ name: 'fk_scope_conv_connector', columns: [t.connector_id], foreignColumns: [connectors.id] }).onDelete('cascade'),
  foreignKey({ name: 'fk_scope_conv_agent',     columns: [t.agent_id],     foreignColumns: [agents.id] }).onDelete('set null'),
  foreignKey({ name: 'fk_scope_conv_conv',      columns: [t.conversation_id], foreignColumns: [conversations.id] }).onDelete('set null'),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_targets — named outbound destinations per connector (Plan 22)
// ─────────────────────────────────────────────────────────────────────────────
export const connector_targets = pgTable('connector_targets', {
  id:           uuid('id').primaryKey().defaultRandom(),
  connector_id: uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  name:         text('name').notNull(),          // slug: "morning-briefing"
  display_name: text('display_name'),
  description:  text('description'),
  ref_keys:     jsonb('ref_keys').notNull(),     // { "chat_id": "-1001234567890" }
  scope_key:    text('scope_key'),               // optional
  metadata:     jsonb('metadata').notNull().default({}),
  created_at:   timestamp('created_at').notNull().defaultNow(),
  updated_at:   timestamp('updated_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('uq_targets_connector_name').on(t.connector_id, t.name),
  index('idx_targets_connector').on(t.connector_id),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_identities — external identity → Jiku mapping
// binding_id is nullable: null = pairing request (no binding yet), non-null = fully bound
// ─────────────────────────────────────────────────────────────────────────────
export const connector_identities = pgTable('connector_identities', {
  id:                uuid('id').primaryKey().defaultRandom(),
  connector_id:      uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  binding_id:        uuid('binding_id').references(() => connector_bindings.id, { onDelete: 'set null' }),
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
  index('idx_identity_connector').on(t.connector_id),
  index('idx_identity_binding').on(t.binding_id),
  index('idx_identity_conversation').on(t.conversation_id),
])

// ─────────────────────────────────────────────────────────────────────────────
// connector_events — raw event log
// ─────────────────────────────────────────────────────────────────────────────
export const connector_events = pgTable('connector_events', {
  id:              uuid('id').primaryKey().defaultRandom(),
  connector_id:    uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  binding_id:      uuid('binding_id').references(() => connector_bindings.id, { onDelete: 'set null' }),
  identity_id:     uuid('identity_id').references(() => connector_identities.id, { onDelete: 'set null' }),
  event_type:      text('event_type').notNull(),
  direction:       text('direction').notNull().default('inbound'),  // 'inbound' | 'outbound'
  ref_keys:        jsonb('ref_keys').notNull(),
  target_ref_keys: jsonb('target_ref_keys'),
  payload:         jsonb('payload').notNull(),
  raw_payload:     jsonb('raw_payload'),
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
  raw_payload:      jsonb('raw_payload'),
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
// connector_invite_codes — one-time or multi-use codes for auto-approving identities
// ─────────────────────────────────────────────────────────────────────────────
export const connector_invite_codes = pgTable('connector_invite_codes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  connector_id: uuid('connector_id').notNull().references(() => connectors.id, { onDelete: 'cascade' }),
  code:         text('code').notNull().unique(),
  label:        text('label'),
  max_uses:     integer('max_uses'),
  use_count:    integer('use_count').notNull().default(0),
  expires_at:   timestamp('expires_at'),
  revoked:      boolean('revoked').notNull().default(false),
  created_by:   uuid('created_by').references(() => users.id),
  created_at:   timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_invite_connector').on(t.connector_id),
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
