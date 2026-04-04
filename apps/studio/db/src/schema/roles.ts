import { pgTable, uuid, varchar, boolean, timestamp, primaryKey, unique } from 'drizzle-orm/pg-core'
import { companies } from './companies.ts'
import { users } from './users.ts'

export const roles = pgTable('roles', {
  id:         uuid('id').primaryKey().defaultRandom(),
  company_id: uuid('company_id').references(() => companies.id).notNull(),
  name:       varchar('name', { length: 100 }).notNull(),
  is_system:  boolean('is_system').default(false),
  created_at: timestamp('created_at').defaultNow(),
})

export const company_members = pgTable('company_members', {
  id:         uuid('id').primaryKey().defaultRandom(),
  company_id: uuid('company_id').references(() => companies.id).notNull(),
  user_id:    uuid('user_id').references(() => users.id).notNull(),
  role_id:    uuid('role_id').references(() => roles.id).notNull(),
  joined_at:  timestamp('joined_at').defaultNow(),
}, t => [unique().on(t.company_id, t.user_id)])

export type Role = typeof roles.$inferSelect
export type NewRole = typeof roles.$inferInsert
export type CompanyMember = typeof company_members.$inferSelect
export type NewCompanyMember = typeof company_members.$inferInsert
