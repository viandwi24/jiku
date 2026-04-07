import { pgTable, uuid, varchar, text, timestamp, unique, integer, jsonb, index, boolean } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

export const agents = pgTable('agents', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  project_id:           uuid('project_id').references(() => projects.id).notNull(),
  name:                 varchar('name', { length: 255 }).notNull(),
  slug:                 varchar('slug', { length: 255 }).notNull(),
  description:          text('description'),
  base_prompt:          text('base_prompt').notNull(),
  allowed_modes:        text('allowed_modes').array().notNull().default(['chat', 'task']),
  /** Context compaction threshold (0–100%). 0 = disabled. Default 80. */
  compaction_threshold: integer('compaction_threshold').default(80).notNull(),
  /** Partial memory config override (null = inherit all from project). */
  memory_config:        jsonb('memory_config').default(null),
  /** Initial persona seed (name, role, personality, etc). Applied once when agent_self is empty. */
  persona_seed:         jsonb('persona_seed').default(null),
  /** Timestamp when persona seed was applied. null = not yet seeded. */
  persona_seeded_at:    timestamp('persona_seeded_at'),
  /** Plain-text persona prompt — injected directly into system prompt. Replaces memory-based persona when set. */
  persona_prompt:       text('persona_prompt'),
  // Plan 11: heartbeat fields
  heartbeat_enabled:    boolean('heartbeat_enabled').notNull().default(true),
  heartbeat_cron:       varchar('heartbeat_cron', { length: 100 }).default('0 */30 * * *'),
  heartbeat_prompt:     text('heartbeat_prompt'),
  heartbeat_last_run_at: timestamp('heartbeat_last_run_at'),
  heartbeat_next_run_at: timestamp('heartbeat_next_run_at'),
  /**
   * Controls which agents this agent is allowed to delegate tasks to via run_task.
   * null  = no restriction (can spawn tasks to any agent in the project)
   * []    = cannot delegate to any agent (delegation fully disabled)
   * [id…] = can only delegate to the listed agent IDs
   */
  task_allowed_agents:  text('task_allowed_agents').array().default(null),
  /** Whether this agent can be used as the target of cron tasks. */
  cron_task_enabled:    boolean('cron_task_enabled').notNull().default(true),
  /** How to deliver chat attachments to the model. 'base64' = inline data URI. 'proxy_url' = server proxy URL. Default base64 (dev-friendly). */
  file_delivery:        varchar('file_delivery', { length: 20 }).notNull().default('base64'),
  /** Scope for chat attachments uploaded by users. 'per_user' or 'shared'. */
  attachment_scope:     varchar('attachment_scope', { length: 20 }).notNull().default('per_user'),
  created_at:           timestamp('created_at').defaultNow(),
}, t => [unique().on(t.project_id, t.slug)])

export type Agent = typeof agents.$inferSelect
export type NewAgent = typeof agents.$inferInsert
