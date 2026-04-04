import { pgTable, uuid, varchar, text, primaryKey } from 'drizzle-orm/pg-core'
import { roles } from './roles.ts'

export const permissions = pgTable('permissions', {
  id:          uuid('id').primaryKey().defaultRandom(),
  key:         varchar('key', { length: 255 }).unique().notNull(),
  description: text('description'),
  plugin_id:   varchar('plugin_id', { length: 255 }),
})

export const role_permissions = pgTable('role_permissions', {
  role_id:       uuid('role_id').references(() => roles.id).notNull(),
  permission_id: uuid('permission_id').references(() => permissions.id).notNull(),
}, t => [primaryKey({ columns: [t.role_id, t.permission_id] })])

export type Permission = typeof permissions.$inferSelect
export type NewPermission = typeof permissions.$inferInsert
export type RolePermission = typeof role_permissions.$inferSelect
