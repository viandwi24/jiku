'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ProjectMember } from '@/lib/api'
import { Switch, Badge } from '@jiku/ui'
import { Star, Eye } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  agentId: string
  projectId: string
}

/**
 * Shows which project members can see this agent and lets admins toggle visibility.
 * - Superadmins always see all agents — shown as read-only.
 * - Members with agents:write always see all agents — shown as read-only.
 * - Everyone else is filtered by their agent_restrictions on membership.
 */
export function AgentVisibilityConfig({ agentId, projectId }: Props) {
  const qc = useQueryClient()

  const { data: membersData, isLoading } = useQuery({
    queryKey: ['acl-members', projectId],
    queryFn: () => api.acl.listMembers(projectId),
    enabled: !!projectId,
  })

  const { data: myPerms } = useQuery({
    queryKey: ['acl-my-perms', projectId],
    queryFn: () => api.acl.getMyPermissions(projectId),
    enabled: !!projectId,
  })

  const setRestrictions = useMutation({
    mutationFn: ({ userId, restrictions }: { userId: string; restrictions: Record<string, boolean> }) =>
      api.acl.setAgentRestrictions(projectId, userId, restrictions),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['acl-members', projectId] })
      toast.success('Visibility updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const canManage = myPerms?.isSuperadmin || myPerms?.permissions.includes('members:write')
  const members = membersData?.members ?? []

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading members...</p>
  }

  if (members.length === 0) {
    return <p className="text-sm text-muted-foreground">No other members in this project.</p>
  }

  return (
    <div className="space-y-1">
      {members.map((m: ProjectMember) => {
        const restrictions: Record<string, boolean> = (m.agent_restrictions as Record<string, boolean>) ?? {}
        const alwaysVisible = m.is_superadmin || (m.role?.permissions ?? []).includes('agents:write')
        const visible = alwaysVisible || restrictions[agentId] !== false

        return (
          <div key={m.user_id} className="flex items-center justify-between rounded-md border px-3 py-2 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{m.user.name}</p>
                <p className="text-xs text-muted-foreground truncate">{m.user.email}</p>
              </div>
              {m.is_superadmin && (
                <Badge variant="secondary" className="gap-1 text-xs py-0 shrink-0">
                  <Star className="w-2.5 h-2.5 fill-yellow-400 text-yellow-400" /> Superadmin
                </Badge>
              )}
              {!m.is_superadmin && alwaysVisible && (
                <Badge variant="outline" className="text-xs py-0 shrink-0 gap-1">
                  <Eye className="w-2.5 h-2.5" /> agents:write
                </Badge>
              )}
            </div>

            {alwaysVisible ? (
              <span className="text-xs text-muted-foreground shrink-0">Always visible</span>
            ) : canManage ? (
              <Switch
                checked={visible}
                disabled={setRestrictions.isPending}
                onCheckedChange={(checked) => {
                  const next = { ...restrictions }
                  if (checked) {
                    delete next[agentId]
                  } else {
                    next[agentId] = false
                  }
                  setRestrictions.mutate({ userId: m.user_id, restrictions: next })
                }}
              />
            ) : (
              <span className="text-xs text-muted-foreground shrink-0">{visible ? 'Visible' : 'Hidden'}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
