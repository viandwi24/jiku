import { pgTable, uuid, varchar, text, timestamp, unique, jsonb, boolean } from 'drizzle-orm/pg-core'
import { companies } from './companies.ts'

export const projects = pgTable('projects', {
  id:            uuid('id').primaryKey().defaultRandom(),
  company_id:    uuid('company_id').references(() => companies.id).notNull(),
  name:          varchar('name', { length: 255 }).notNull(),
  slug:          varchar('slug', { length: 255 }).notNull(),
  /** Project-level memory config defaults (null = use platform defaults). */
  memory_config:   jsonb('memory_config').default(null),
  /** Browser automation feature toggle. */
  browser_enabled: boolean('browser_enabled').notNull().default(false),
  /** Browser config (mode, cdpUrl, headless, etc.). */
  browser_config:  jsonb('browser_config').default(null),
  /**
   * Plan 22 revision — IANA timezone (e.g. "Asia/Jakarta") used as the fallback
   * when users mention local times without specifying a zone. DB timestamps stay UTC;
   * this is for prompt context + UI display only.
   */
  default_timezone: text('default_timezone').notNull().default('Asia/Jakarta'),
  created_at:      timestamp('created_at').defaultNow(),
}, t => [unique().on(t.company_id, t.slug)])

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
