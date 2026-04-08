import { pgTable, uuid, text, boolean, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { agents } from './agents.ts'

export const mcp_servers = pgTable('mcp_servers', {
  id:         uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agent_id:   uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  name:       text('name').notNull(),
  transport:  text('transport').notNull(), // 'stdio' | 'sse' | 'streamable-http'
  config:     jsonb('config').notNull(),   // { url?, command?, args?, env?, headers? }
  enabled:    boolean('enabled').notNull().default(true),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
}, t => [
  index('idx_mcp_servers_project').on(t.project_id),
])

export const project_tool_states = pgTable('project_tool_states', {
  id:         uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  tool_id:    text('tool_id').notNull(),
  enabled:    boolean('enabled').notNull().default(true),
  created_at: timestamp('created_at').defaultNow(),
}, t => [
  unique().on(t.project_id, t.tool_id),
  index('idx_tool_states_project').on(t.project_id),
])

export const agent_tool_states = pgTable('agent_tool_states', {
  id:       uuid('id').primaryKey().defaultRandom(),
  agent_id: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  tool_id:  text('tool_id').notNull(),
  enabled:  boolean('enabled').notNull().default(true),
  created_at: timestamp('created_at').defaultNow(),
}, t => [
  unique().on(t.agent_id, t.tool_id),
  index('idx_tool_states_agent').on(t.agent_id),
])

export type McpServer = typeof mcp_servers.$inferSelect
export type NewMcpServer = typeof mcp_servers.$inferInsert
export type ProjectToolState = typeof project_tool_states.$inferSelect
export type AgentToolState = typeof agent_tool_states.$inferSelect
