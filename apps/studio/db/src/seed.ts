import { db } from './client.ts'
import { roles, permissions, role_permissions, companies, users, company_members } from './schema/index.ts'
import { eq } from 'drizzle-orm'

// Default system permissions
const SYSTEM_PERMISSIONS = [
  { key: 'jiku.social:post:write', description: 'Create and edit social media posts', plugin_id: 'jiku.social' },
  { key: 'jiku.social:post:read', description: 'View social media posts', plugin_id: 'jiku.social' },
  { key: 'jiku.social:post:delete', description: 'Delete social media posts', plugin_id: 'jiku.social' },
]

// System role names
export const SYSTEM_ROLES = ['Owner', 'Admin', 'Member'] as const

export async function seedPermissions() {
  for (const perm of SYSTEM_PERMISSIONS) {
    await db
      .insert(permissions)
      .values(perm)
      .onConflictDoNothing({ target: permissions.key })
  }
  console.log('[seed] permissions seeded')
}

export async function seedCompanySystemRoles(companyId: string) {
  const existingRoles = await db.query.roles.findMany({
    where: (t, { and, eq: eqFn }) => and(eqFn(t.company_id, companyId), eqFn(t.is_system, true)),
  })
  if (existingRoles.length >= SYSTEM_ROLES.length) return existingRoles

  const createdRoles: typeof roles.$inferSelect[] = []
  for (const roleName of SYSTEM_ROLES) {
    const exists = existingRoles.find(r => r.name === roleName)
    if (exists) {
      createdRoles.push(exists)
      continue
    }
    const [role] = await db
      .insert(roles)
      .values({ company_id: companyId, name: roleName, is_system: true })
      .returning()
    createdRoles.push(role!)
  }

  // Assign all permissions to Owner, read permissions to Admin + Member
  const allPerms = await db.query.permissions.findMany()
  const ownerRole = createdRoles.find(r => r.name === 'Owner')!
  const adminRole = createdRoles.find(r => r.name === 'Admin')!
  const memberRole = createdRoles.find(r => r.name === 'Member')!

  for (const perm of allPerms) {
    await db
      .insert(role_permissions)
      .values({ role_id: ownerRole.id, permission_id: perm.id })
      .onConflictDoNothing()

    if (perm.key.endsWith(':read')) {
      await db
        .insert(role_permissions)
        .values({ role_id: adminRole.id, permission_id: perm.id })
        .onConflictDoNothing()
      await db
        .insert(role_permissions)
        .values({ role_id: memberRole.id, permission_id: perm.id })
        .onConflictDoNothing()
    } else {
      await db
        .insert(role_permissions)
        .values({ role_id: adminRole.id, permission_id: perm.id })
        .onConflictDoNothing()
    }
  }

  console.log(`[seed] system roles seeded for company ${companyId}`)
  return createdRoles
}
