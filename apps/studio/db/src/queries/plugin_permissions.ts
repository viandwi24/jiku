import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  plugin_granted_permissions,
  type NewPluginGrantedPermission,
  type PluginGrantedPermission,
} from '../schema/plugin_granted_permissions.ts'
import { project_memberships } from '../schema/acl.ts'
import { users } from '../schema/users.ts'

export async function getGrantedPluginPermissions(
  userId: string | null,
  projectId: string,
): Promise<string[]> {
  if (!userId) return []
  const membership = await db
    .select({ id: project_memberships.id })
    .from(project_memberships)
    .where(and(
      eq(project_memberships.project_id, projectId),
      eq(project_memberships.user_id, userId),
    ))
    .limit(1)
  const membershipId = membership[0]?.id
  if (!membershipId) return []

  const rows = await db
    .select({ permission: plugin_granted_permissions.permission })
    .from(plugin_granted_permissions)
    .where(eq(plugin_granted_permissions.membership_id, membershipId))

  return rows.map(r => r.permission)
}

export async function grantPluginPermission(entry: NewPluginGrantedPermission): Promise<PluginGrantedPermission> {
  const [row] = await db
    .insert(plugin_granted_permissions)
    .values(entry)
    .onConflictDoNothing()
    .returning()
  if (row) return row
  const existing = await db
    .select()
    .from(plugin_granted_permissions)
    .where(and(
      eq(plugin_granted_permissions.membership_id, entry.membership_id),
      eq(plugin_granted_permissions.plugin_id, entry.plugin_id),
      eq(plugin_granted_permissions.permission, entry.permission),
    ))
    .limit(1)
  return existing[0]!
}

export async function revokePluginPermission(id: string): Promise<void> {
  await db.delete(plugin_granted_permissions).where(eq(plugin_granted_permissions.id, id))
}

export async function revokePluginPermissionByKey(
  membershipId: string,
  pluginId: string,
  permission: string,
): Promise<void> {
  await db.delete(plugin_granted_permissions).where(and(
    eq(plugin_granted_permissions.membership_id, membershipId),
    eq(plugin_granted_permissions.plugin_id, pluginId),
    eq(plugin_granted_permissions.permission, permission),
  ))
}

export interface MemberPluginPermissionRow extends PluginGrantedPermission {
  user: { id: string; name: string; email: string } | null
}

export async function listProjectPluginPermissions(projectId: string): Promise<MemberPluginPermissionRow[]> {
  const rows = await db
    .select({
      grant: plugin_granted_permissions,
      membership: project_memberships,
      user: { id: users.id, name: users.name, email: users.email },
    })
    .from(plugin_granted_permissions)
    .leftJoin(project_memberships, eq(plugin_granted_permissions.membership_id, project_memberships.id))
    .leftJoin(users, eq(project_memberships.user_id, users.id))
    .where(eq(plugin_granted_permissions.project_id, projectId))

  return rows.map(r => ({
    ...r.grant,
    user: r.user?.id ? r.user as { id: string; name: string; email: string } : null,
  }))
}

export async function listMemberPluginPermissions(
  projectId: string,
  userId: string,
): Promise<PluginGrantedPermission[]> {
  const membership = await db
    .select({ id: project_memberships.id })
    .from(project_memberships)
    .where(and(
      eq(project_memberships.project_id, projectId),
      eq(project_memberships.user_id, userId),
    ))
    .limit(1)
  const membershipId = membership[0]?.id
  if (!membershipId) return []

  return db
    .select()
    .from(plugin_granted_permissions)
    .where(eq(plugin_granted_permissions.membership_id, membershipId))
}

export async function replaceMemberPluginPermissions(
  projectId: string,
  userId: string,
  grants: Array<{ plugin_id: string; permission: string }>,
  grantedBy: string | null,
): Promise<void> {
  const membership = await db
    .select({ id: project_memberships.id })
    .from(project_memberships)
    .where(and(
      eq(project_memberships.project_id, projectId),
      eq(project_memberships.user_id, userId),
    ))
    .limit(1)
  const membershipId = membership[0]?.id
  if (!membershipId) throw new Error('User is not a project member')

  await db.transaction(async (tx) => {
    await tx
      .delete(plugin_granted_permissions)
      .where(eq(plugin_granted_permissions.membership_id, membershipId))
    if (grants.length > 0) {
      await tx.insert(plugin_granted_permissions).values(
        grants.map(g => ({
          project_id: projectId,
          membership_id: membershipId,
          plugin_id: g.plugin_id,
          permission: g.permission,
          granted_by: grantedBy,
        })),
      )
    }
  })
}

export async function getMembershipsForUsers(
  projectId: string,
  userIds: string[],
): Promise<Record<string, string>> {
  if (userIds.length === 0) return {}
  const rows = await db
    .select({ id: project_memberships.id, user_id: project_memberships.user_id })
    .from(project_memberships)
    .where(and(
      eq(project_memberships.project_id, projectId),
      inArray(project_memberships.user_id, userIds),
    ))
  return Object.fromEntries(rows.map(r => [r.user_id, r.id]))
}
