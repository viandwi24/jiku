import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core'
import { companies } from './companies.ts'
import { projects } from './projects.ts'
import { users } from './users.ts'

// ─── Project Roles ────────────────────────────────────────────────────────────

export const project_roles = pgTable('project_roles', {
  id:          uuid('id').primaryKey().defaultRandom(),
  project_id:  uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  name:        varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  /** Array of permission strings: ['chats:read', 'memory:read', ...] */
  permissions: text('permissions').array().notNull().default([]),
  is_default:  boolean('is_default').notNull().default(false),
  created_at:  timestamp('created_at').defaultNow(),
  updated_at:  timestamp('updated_at').defaultNow(),
}, t => [
  unique().on(t.project_id, t.name),
  index('idx_project_roles_project').on(t.project_id),
])

// ─── Project Memberships ──────────────────────────────────────────────────────

export const project_memberships = pgTable('project_memberships', {
  id:          uuid('id').primaryKey().defaultRandom(),
  project_id:  uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  user_id:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role_id:     uuid('role_id').references(() => project_roles.id, { onDelete: 'set null' }),

  is_superadmin: boolean('is_superadmin').notNull().default(false),

  /** { "agent-uuid": false } — false = blocked */
  agent_restrictions: jsonb('agent_restrictions').notNull().default({}),

  /** { "agent-uuid": { "tool_name": false } } */
  tool_restrictions: jsonb('tool_restrictions').notNull().default({}),

  joined_at: timestamp('joined_at').defaultNow(),
}, t => [
  unique().on(t.project_id, t.user_id),
  index('idx_project_memberships_project').on(t.project_id),
  index('idx_project_memberships_user').on(t.user_id),
])

// ─── Invitations ──────────────────────────────────────────────────────────────

export const invitations = pgTable('invitations', {
  id:         uuid('id').primaryKey().defaultRandom(),
  company_id: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }).notNull(),

  email: varchar('email', { length: 255 }).notNull(),

  /** [{ project_id, role_id }] — project access granted on accept */
  project_grants: jsonb('project_grants').notNull().default([]),

  status: varchar('status', { length: 20 }).notNull().default('pending'),
  // 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'

  invited_by:  uuid('invited_by').references(() => users.id).notNull(),
  expires_at:  timestamp('expires_at').notNull(),

  accepted_by: uuid('accepted_by').references(() => users.id),
  accepted_at: timestamp('accepted_at'),

  created_at: timestamp('created_at').defaultNow(),
}, t => [
  index('idx_invitations_company').on(t.company_id),
  index('idx_invitations_email').on(t.email, t.status),
])

// ─── Superadmin Transfer Log ──────────────────────────────────────────────────

export const superadmin_transfers = pgTable('superadmin_transfers', {
  id:             uuid('id').primaryKey().defaultRandom(),
  project_id:     uuid('project_id').references(() => projects.id).notNull(),
  from_user_id:   uuid('from_user_id').references(() => users.id).notNull(),
  to_user_id:     uuid('to_user_id').references(() => users.id).notNull(),
  transferred_at: timestamp('transferred_at').defaultNow(),
})

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProjectRole = typeof project_roles.$inferSelect
export type NewProjectRole = typeof project_roles.$inferInsert

export type ProjectMembership = typeof project_memberships.$inferSelect
export type NewProjectMembership = typeof project_memberships.$inferInsert

export type Invitation = typeof invitations.$inferSelect
export type NewInvitation = typeof invitations.$inferInsert

export type SuperadminTransfer = typeof superadmin_transfers.$inferSelect
