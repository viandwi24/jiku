import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users.ts'

export const companies = pgTable('companies', {
  id:         uuid('id').primaryKey().defaultRandom(),
  name:       varchar('name', { length: 255 }).notNull(),
  slug:       varchar('slug', { length: 255 }).unique().notNull(),
  owner_id:   uuid('owner_id').references(() => users.id).notNull(),
  created_at: timestamp('created_at').defaultNow(),
})

export type Company = typeof companies.$inferSelect
export type NewCompany = typeof companies.$inferInsert
