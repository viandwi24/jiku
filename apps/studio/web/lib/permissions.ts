/**
 * Permission utilities for the frontend.
 *
 * Usage (hook):
 *   const { can, isSuperadmin, isLoading } = useProjectPermission(projectId)
 *   if (can('agents:read')) { ... }
 *
 * Usage (guard component):
 *   <PermissionGuard projectId={id} permission="agents:write">
 *     <EditButton />
 *   </PermissionGuard>
 *
 * Usage (page guard HOC):
 *   export default withPermissionGuard(MyPage, 'chats:read')
 *   // Requires params: { company, project } — resolves projectId automatically
 */

import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { ResolvedProjectPermissions } from './api'

// ─── Core hook ────────────────────────────────────────────────────────────────

export interface ProjectPermissionState {
  /** Whether the user has the given permission (or is superadmin) */
  can: (permission: string) => boolean
  /** Whether the user is a project superadmin */
  isSuperadmin: boolean
  /** Whether the user has any membership in this project */
  isMember: boolean
  /** Raw permission strings from their role */
  permissions: string[]
  /** True while the permissions query is in flight */
  isLoading: boolean
  /** Raw resolved data (undefined while loading) */
  resolved: ResolvedProjectPermissions | undefined
}

export function useProjectPermission(projectId: string | undefined): ProjectPermissionState {
  const { data: resolved, isLoading } = useQuery({
    queryKey: ['acl-my-perms', projectId],
    queryFn: () => api.acl.getMyPermissions(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  })

  const isSuperadmin = resolved?.isSuperadmin ?? false
  const isMember = resolved?.granted ?? false
  const permissions = resolved?.permissions ?? []

  function can(permission: string): boolean {
    // While loading: optimistically allow (prevents flash of empty UI)
    if (isLoading || !resolved) return true
    if (isSuperadmin) return true
    return permissions.includes(permission)
  }

  return { can, isSuperadmin, isMember, permissions, isLoading, resolved }
}

// ─── Hook that resolves projectId from slugs ──────────────────────────────────

export function useProjectPermissionBySlugs(
  companySlug: string | undefined,
  projectSlug: string | undefined,
): ProjectPermissionState {
  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
    enabled: !!companySlug,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })

  return useProjectPermission(projectsData?.id)
}
