import { getMember, getAgentUserPolicy, getUserById } from '@jiku-studio/db'

export interface CallerContext {
  user_id: string
  roles: string[]
  permissions: string[]
  attributes: Record<string, string | string[]>
  user_data: Record<string, unknown>
}

export async function resolveCaller(
  userId: string,
  companyId: string,
  agentId: string,
): Promise<CallerContext> {
  const member = await getMember(companyId, userId)
  if (!member) throw new Error('Not a member of this company')

  const actualPermissions = member.role.role_permissions.map(
    (rp) => rp.permission.key
  )
  const roleName = member.role.name

  const selfPolicy = await getAgentUserPolicy(agentId, userId)

  const effectivePermissions =
    selfPolicy && selfPolicy.allowed_permissions.length > 0
      ? actualPermissions.filter(p => selfPolicy.allowed_permissions.includes(p))
      : actualPermissions

  const user = await getUserById(userId)

  return {
    user_id: userId,
    roles: [roleName],
    permissions: effectivePermissions,
    attributes: {
      company_id: companyId,
    },
    user_data: {
      name: user?.name ?? '',
      email: user?.email ?? '',
      company_id: companyId,
      actual_permissions: actualPermissions,
    },
  }
}
