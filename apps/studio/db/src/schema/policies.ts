import { pgTable, uuid, varchar, text, integer, timestamp, unique, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core'
import { agents } from './agents.ts'
import { users } from './users.ts'
import { companies } from './companies.ts'

// Reusable policy entity — one policy can attach to many agents
export const policies = pgTable('policies', {
  id:          uuid('id').primaryKey().defaultRandom(),
  company_id:  uuid('company_id').references(() => companies.id).notNull(),
  name:        varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  is_template: boolean('is_template').default(false),
  created_at:  timestamp('created_at').defaultNow(),
})

// Rules belong to a policy (not directly to an agent)
export const policy_rules = pgTable('policy_rules', {
  id:            uuid('id').primaryKey().defaultRandom(),
  policy_id:     uuid('policy_id').references(() => policies.id).notNull(),
  resource_type: varchar('resource_type', { length: 100 }).notNull(),
  resource_id:   varchar('resource_id', { length: 255 }).notNull(),
  subject_type:  varchar('subject_type', { length: 100 }).notNull(),
  subject:       varchar('subject', { length: 255 }).notNull(),
  effect:        varchar('effect', { length: 20 }).notNull(),
  priority:      integer('priority').default(0),
  // PolicyCondition[] stored as JSONB
  conditions:    jsonb('conditions').default([]),
})

// Many-to-many: agent ↔ policy
export const agent_policies = pgTable('agent_policies', {
  agent_id:  uuid('agent_id').references(() => agents.id).notNull(),
  policy_id: uuid('policy_id').references(() => policies.id).notNull(),
  priority:  integer('priority').default(0),
}, t => [primaryKey({ columns: [t.agent_id, t.policy_id] })])

// Self-restriction per user per agent (unchanged)
export const agent_user_policies = pgTable('agent_user_policies', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  agent_id:            uuid('agent_id').references(() => agents.id).notNull(),
  user_id:             uuid('user_id').references(() => users.id).notNull(),
  allowed_permissions: text('allowed_permissions').array().notNull().default([]),
  updated_at:          timestamp('updated_at').defaultNow(),
}, t => [unique().on(t.agent_id, t.user_id)])

export type Policy = typeof policies.$inferSelect
export type NewPolicy = typeof policies.$inferInsert
export type PolicyRule = typeof policy_rules.$inferSelect
export type NewPolicyRule = typeof policy_rules.$inferInsert
export type AgentPolicy = typeof agent_policies.$inferSelect
export type AgentUserPolicy = typeof agent_user_policies.$inferSelect
export type NewAgentUserPolicy = typeof agent_user_policies.$inferInsert
