import { pgTable, uuid, varchar, text, timestamp, jsonb, unique } from 'drizzle-orm/pg-core'
import { users } from './users.ts'
import { agents } from './agents.ts'

export const credentials = pgTable('credentials', {
  id:               uuid('id').primaryKey().defaultRandom(),
  name:             varchar('name', { length: 255 }).notNull(),
  description:      text('description'),
  group_id:         varchar('group_id', { length: 100 }).notNull(),
  adapter_id:       varchar('adapter_id', { length: 100 }).notNull(),
  scope:            varchar('scope', { length: 20 }).notNull(),
  // 'company' | 'project'
  scope_id:         uuid('scope_id').notNull(),
  // company_id or project_id depending on scope
  fields_encrypted: text('fields_encrypted'),
  // AES-256-GCM encrypted JSON: { api_key: '...', bot_token: '...' }
  metadata:         jsonb('metadata').$type<Record<string, string>>().default({}),
  // Plain JSON: { org_id: '...', base_url: '...' }
  created_by:       uuid('created_by').references(() => users.id),
  created_at:       timestamp('created_at').defaultNow(),
  updated_at:       timestamp('updated_at').defaultNow(),
})

// Agent ↔ Credential assignment (one-to-one: one agent has one primary credential)
export const agent_credentials = pgTable('agent_credentials', {
  id:                uuid('id').primaryKey().defaultRandom(),
  agent_id:          uuid('agent_id').references(() => agents.id).notNull(),
  credential_id:     uuid('credential_id').references(() => credentials.id).notNull(),
  model_id:          varchar('model_id', { length: 255 }),
  // model selected: 'gpt-4o', 'claude-sonnet-4-6', etc.
  metadata_override: jsonb('metadata_override').$type<Record<string, string>>().default({}),
  // Per-agent override, merged with credential.metadata (agent override wins)
}, t => [unique().on(t.agent_id)])

export type Credential = typeof credentials.$inferSelect
export type NewCredential = typeof credentials.$inferInsert
export type AgentCredential = typeof agent_credentials.$inferSelect
export type NewAgentCredential = typeof agent_credentials.$inferInsert
