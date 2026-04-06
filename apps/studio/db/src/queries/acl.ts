import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  project_roles,
  project_memberships,
  invitations,
  superadmin_transfers,
  users,
  projects,
} from '../schema/index.ts'
import type {
  NewProjectRole,
  NewProjectMembership,
  NewInvitation,
} from '../schema/index.ts'

// ─── Project Roles ────────────────────────────────────────────────────────────

export async function listProjectRoles(projectId: string) {
  return db.query.project_roles.findMany({
    where: eq(project_roles.project_id, projectId),
    orderBy: project_roles.name,
  })
}

export async function getProjectRoleById(roleId: string) {
  return db.query.project_roles.findFirst({
    where: eq(project_roles.id, roleId),
  })
}

export async function createProjectRole(data: Omit<NewProjectRole, 'id' | 'created_at' | 'updated_at'>) {
  const [role] = await db.insert(project_roles).values(data).returning()
  return role!
}

export async function updateProjectRole(roleId: string, data: Partial<Pick<NewProjectRole, 'name' | 'description' | 'permissions' | 'is_default'>>) {
  const [role] = await db
    .update(project_roles)
    .set({ ...data, updated_at: new Date() })
    .where(eq(project_roles.id, roleId))
    .returning()
  return role!
}

export async function deleteProjectRole(roleId: string) {
  await db.delete(project_roles).where(eq(project_roles.id, roleId))
}

export async function getDefaultProjectRole(projectId: string) {
  return db.query.project_roles.findFirst({
    where: and(
      eq(project_roles.project_id, projectId),
      eq(project_roles.is_default, true),
    ),
  })
}

// ─── Project Memberships ──────────────────────────────────────────────────────

export async function listProjectMembers(projectId: string) {
  return db.query.project_memberships.findMany({
    where: eq(project_memberships.project_id, projectId),
    with: {
      user: true,
      role: true,
    },
  })
}

export async function getProjectMembership(projectId: string, userId: string) {
  return db.query.project_memberships.findFirst({
    where: and(
      eq(project_memberships.project_id, projectId),
      eq(project_memberships.user_id, userId),
    ),
    with: { role: true },
  })
}

/** List all project memberships for a user within projects that belong to a company */
export async function listUserProjectMembershipsInCompany(companyId: string, userId: string) {
  const companyProjects = await db.query.projects.findMany({
    where: eq(projects.company_id, companyId),
  })
  if (companyProjects.length === 0) return []

  const projectIds = companyProjects.map(p => p.id)
  const memberships = await db.query.project_memberships.findMany({
    where: and(
      eq(project_memberships.user_id, userId),
      inArray(project_memberships.project_id, projectIds),
    ),
    with: { role: true },
  })

  return memberships.map(m => ({
    ...m,
    project: companyProjects.find(p => p.id === m.project_id)!,
  }))
}

export async function createProjectMembership(data: Omit<NewProjectMembership, 'id' | 'joined_at'>) {
  const [membership] = await db.insert(project_memberships).values(data).returning()
  return membership!
}

export async function updateProjectMembership(
  projectId: string,
  userId: string,
  data: Partial<Pick<NewProjectMembership, 'role_id' | 'is_superadmin' | 'agent_restrictions' | 'tool_restrictions'>>,
) {
  const [membership] = await db
    .update(project_memberships)
    .set(data)
    .where(and(
      eq(project_memberships.project_id, projectId),
      eq(project_memberships.user_id, userId),
    ))
    .returning()
  return membership!
}

export async function removeProjectMembership(projectId: string, userId: string) {
  await db.delete(project_memberships).where(
    and(
      eq(project_memberships.project_id, projectId),
      eq(project_memberships.user_id, userId),
    ),
  )
}

/** Resolve effective permissions for a user in a project */
export async function resolveProjectPermissions(projectId: string, userId: string) {
  const membership = await getProjectMembership(projectId, userId)
  if (!membership) {
    return { granted: false, isSuperadmin: false, permissions: [] as string[], agentRestrictions: {} as Record<string, boolean>, toolRestrictions: {} as Record<string, Record<string, boolean>> }
  }

  return {
    granted: true,
    isSuperadmin: membership.is_superadmin,
    permissions: (membership.role?.permissions ?? []) as string[],
    agentRestrictions: (membership.agent_restrictions ?? {}) as Record<string, boolean>,
    toolRestrictions: (membership.tool_restrictions ?? {}) as Record<string, Record<string, boolean>>,
  }
}

// ─── Superadmin Transfer Log ──────────────────────────────────────────────────

export async function logSuperadminTransfer(projectId: string, fromUserId: string, toUserId: string) {
  const [record] = await db
    .insert(superadmin_transfers)
    .values({ project_id: projectId, from_user_id: fromUserId, to_user_id: toUserId })
    .returning()
  return record!
}

// ─── Invitations ──────────────────────────────────────────────────────────────

export async function createInvitation(data: Omit<NewInvitation, 'id' | 'created_at'>) {
  const [invitation] = await db.insert(invitations).values(data).returning()
  return invitation!
}

export async function listCompanyInvitations(companyId: string) {
  return db.query.invitations.findMany({
    where: eq(invitations.company_id, companyId),
    with: { invited_by_user: true },
    orderBy: invitations.created_at,
  })
}

export async function listPendingInvitationsForEmail(email: string) {
  return db.query.invitations.findMany({
    where: and(
      eq(invitations.email, email),
      eq(invitations.status, 'pending'),
    ),
    with: {
      company: true,
      invited_by_user: true,
    },
  })
}

export async function getInvitationById(id: string) {
  return db.query.invitations.findFirst({
    where: eq(invitations.id, id),
    with: {
      company: true,
      invited_by_user: true,
    },
  })
}

export async function updateInvitationStatus(
  id: string,
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled',
  acceptedBy?: string,
) {
  const [invitation] = await db
    .update(invitations)
    .set({
      status,
      ...(acceptedBy ? { accepted_by: acceptedBy, accepted_at: new Date() } : {}),
    })
    .where(eq(invitations.id, id))
    .returning()
  return invitation!
}

export async function cancelInvitation(id: string) {
  return updateInvitationStatus(id, 'cancelled')
}
