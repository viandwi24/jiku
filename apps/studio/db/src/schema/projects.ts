import { pgTable, uuid, varchar, timestamp, unique, jsonb } from 'drizzle-orm/pg-core'
import { companies } from './companies.ts'

export const projects = pgTable('projects', {
  id:            uuid('id').primaryKey().defaultRandom(),
  company_id:    uuid('company_id').references(() => companies.id).notNull(),
  name:          varchar('name', { length: 255 }).notNull(),
  slug:          varchar('slug', { length: 255 }).notNull(),
  /** Project-level memory config defaults (null = use platform defaults). */
  memory_config: jsonb('memory_config').default(null),
  created_at:    timestamp('created_at').defaultNow(),
}, t => [unique().on(t.company_id, t.slug)])

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
