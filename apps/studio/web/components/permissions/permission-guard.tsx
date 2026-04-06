'use client'

/**
 * Components for declarative permission-based rendering.
 *
 * ─── Inline guard (hide/show a block) ─────────────────────────────────────────
 *
 *   <PermissionGuard projectId={id} permission="agents:write">
 *     <Button>Edit Agent</Button>
 *   </PermissionGuard>
 *
 * ─── Page-level guard (full page redirect or 403) ─────────────────────────────
 *
 *   Place at the top of any project page:
 *
 *   <ProjectPageGuard companySlug={company} projectSlug={project} permission="chats:read">
 *     {children}
 *   </ProjectPageGuard>
 *
 * ─── HOC for page components ──────────────────────────────────────────────────
 *
 *   export default withPermissionGuard(MyPage, 'runs:read')
 *   // Page must accept params: Promise<{ company: string; project: string }>
 */

import { use, type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { ShieldOff } from 'lucide-react'
import { useProjectPermission, useProjectPermissionBySlugs } from '@/lib/permissions'

// ─── Inline guard ─────────────────────────────────────────────────────────────

interface PermissionGuardProps {
  projectId: string
  permission: string
  children: ReactNode
  fallback?: ReactNode
}

export function PermissionGuard({ projectId, permission, children, fallback = null }: PermissionGuardProps) {
  const { can, isLoading } = useProjectPermission(projectId)
  if (isLoading) return null
  if (!can(permission)) return <>{fallback}</>
  return <>{children}</>
}

// ─── Page-level guard (client component) ─────────────────────────────────────

interface ProjectPageGuardProps {
  companySlug: string
  projectSlug: string
  permission: string
  children: ReactNode
}

export function ProjectPageGuard({ companySlug, projectSlug, permission, children }: ProjectPageGuardProps) {
  const { can, isMember, isLoading } = useProjectPermissionBySlugs(companySlug, projectSlug)

  // While loading, render children (prevents flash)
  if (isLoading) return <>{children}</>

  // Not a member at all
  if (!isMember) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <ShieldOff className="w-8 h-8 text-muted-foreground/50" />
        <p className="text-sm font-medium">Access Denied</p>
        <p className="text-xs text-muted-foreground">You are not a member of this project.</p>
      </div>
    )
  }

  // Member but missing permission
  if (!can(permission)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <ShieldOff className="w-8 h-8 text-muted-foreground/50" />
        <p className="text-sm font-medium">Permission Required</p>
        <p className="text-xs text-muted-foreground">
          You need the <code className="bg-muted px-1 rounded text-xs">{permission}</code> permission to view this page.
          Contact your project administrator.
        </p>
      </div>
    )
  }

  return <>{children}</>
}

// ─── HOC for page components ──────────────────────────────────────────────────

type PageProps = { params: Promise<{ company: string; project: string }> }

export function withPermissionGuard<P extends PageProps>(
  Page: (props: P) => ReactNode,
  permission: string,
) {
  return function GuardedPage(props: P) {
    const { company, project } = use(props.params)
    return (
      <ProjectPageGuard companySlug={company} projectSlug={project} permission={permission}>
        <Page {...props} />
      </ProjectPageGuard>
    )
  }
}
