import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

export const agents = pgTable('agents', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').references(() => projects.id).notNull(),
  name:          varchar('name', { length: 255 }).notNull(),
  description:   text('description'),
  base_prompt:   text('base_prompt').notNull(),
  allowed_modes: text('allowed_modes').array().notNull().default(['chat']),
  provider_id:   varchar('provider_id', { length: 100 }).notNull().default('anthropic'),
  model_id:      varchar('model_id', { length: 100 }).notNull().default('claude-sonnet-4-5'),
  created_at:    timestamp('created_at').defaultNow(),
})

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
