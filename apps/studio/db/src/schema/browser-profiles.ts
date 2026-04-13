// Plan 20 — Browser profiles. One project can have N profiles. Each profile
// pins an adapter (by stable id) and carries that adapter's config.

import { pgTable, uuid, varchar, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { projects } from './projects.ts'

export const browserProfiles = pgTable('browser_profiles', {
  id:        uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name:      varchar('name', { length: 255 }).notNull(),
  adapter_id: varchar('adapter_id', { length: 255 }).notNull(),
  config:    jsonb('config').notNull().default({}),
  enabled:   boolean('enabled').notNull().default(true),
  is_default: boolean('is_default').notNull().default(false),
  created_at: timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  index('idx_browser_profiles_project').on(t.project_id),
  uniqueIndex('idx_browser_profiles_name').on(t.project_id, t.name),
  uniqueIndex('idx_browser_profiles_default').on(t.project_id).where(sql`${t.is_default} = true`),
])

export type BrowserProfile = typeof browserProfiles.$inferSelect
export type NewBrowserProfile = typeof browserProfiles.$inferInsert
