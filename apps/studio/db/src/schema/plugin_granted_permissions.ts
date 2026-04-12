import { pgTable, uuid, text, timestamp, index, unique, foreignKey } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'
import { users } from './users.ts'
import { project_memberships } from './acl.ts'

// Plan 18 — per-member grant of plugin-declared permissions (e.g. 'telegram:send_message').
// Separate from project_plugins.granted_permissions (which is project-wide).
//
// FKs are named explicitly to stay under PG's 63-char identifier limit — the
// auto-generated name `plugin_granted_permissions_membership_id_project_memberships_id_fk`
// is 65 chars and triggers a NOTICE on db:push.
export const plugin_granted_permissions = pgTable('plugin_granted_permissions', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').notNull(),
  membership_id: uuid('membership_id').notNull(),
  plugin_id:     text('plugin_id').notNull(),
  permission:    text('permission').notNull(),
  granted_by:    uuid('granted_by'),
  created_at:    timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  foreignKey({
    name: 'plugin_granted_project_fk',
    columns: [t.project_id],
    foreignColumns: [projects.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'plugin_granted_membership_fk',
    columns: [t.membership_id],
    foreignColumns: [project_memberships.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'plugin_granted_granted_by_fk',
    columns: [t.granted_by],
    foreignColumns: [users.id],
  }).onDelete('set null'),
  unique('plugin_granted_unique').on(t.membership_id, t.plugin_id, t.permission),
  index('plugin_granted_project_idx').on(t.project_id),
  index('plugin_granted_membership_idx').on(t.membership_id),
])

export type PluginGrantedPermission = typeof plugin_granted_permissions.$inferSelect
export type NewPluginGrantedPermission = typeof plugin_granted_permissions.$inferInsert
