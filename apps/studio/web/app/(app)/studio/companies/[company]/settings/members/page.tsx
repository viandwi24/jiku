'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { CompanyMemberItem, MemberProjectItem, Project, ProjectRole } from '@/lib/api'
import {
  Button, Badge,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@jiku/ui'
import { UserMinus, ChevronDown, ChevronRight, Plus, X, FolderKanban } from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'

interface PageProps {
  params: Promise<{ company: string }>
}

// ─── Project access panel (expanded per member) ───────────────────────────────

function MemberProjectAccess({
  companyId,
  userId,
  projects,
}: {
  companyId: string
  userId: string
  projects: Project[]
}) {
  const qc = useQueryClient()
  const [rolesCache, setRolesCache] = useState<Record<string, ProjectRole[]>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['member-projects', companyId, userId],
    queryFn: () => api.acl.listMemberProjects(companyId, userId),
  })

  const memberships = data?.memberships ?? []
  const accessedProjectIds = new Set(memberships.map(m => m.project_id))
  const availableProjects = projects.filter(p => !accessedProjectIds.has(p.id))

  async function ensureRoles(projectId: string) {
    if (!projectId || rolesCache[projectId]) return
    try {
      const d = await api.acl.listRoles(projectId)
      setRolesCache(prev => ({ ...prev, [projectId]: d.roles }))
    } catch { /* ignore */ }
  }

  const grantMutation = useMutation({
    mutationFn: (body: { project_id: string; role_id?: string }) =>
      api.acl.grantMemberProject(companyId, userId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['member-projects', companyId, userId] })
      toast.success('Project access granted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const revokeMutation = useMutation({
    mutationFn: (projectId: string) =>
      api.acl.revokeMemberProject(companyId, userId, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['member-projects', companyId, userId] })
      toast.success('Project access removed')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({ projectId, roleId }: { projectId: string; roleId: string | null }) =>
      api.acl.assignRole(projectId, userId, roleId ?? ''),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['member-projects', companyId, userId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  if (isLoading) return <div className="px-4 py-2 text-xs text-muted-foreground">Loading...</div>

  return (
    <div className="bg-muted/30 border-t px-4 py-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Project Access</p>

      {memberships.length === 0 && (
        <p className="text-xs text-muted-foreground">No project access yet.</p>
      )}

      {memberships.map((m: MemberProjectItem) => {
        const roles = rolesCache[m.project_id] ?? []

        return (
          <div key={m.project_id} className="flex items-center gap-2">
            <FolderKanban className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium flex-1 truncate">{m.project.name}</span>

            <Select
              value={m.role_id ?? '__none__'}
              onValueChange={async (val) => {
                await ensureRoles(m.project_id)
                updateRoleMutation.mutate({
                  projectId: m.project_id,
                  roleId: val === '__none__' ? null : val,
                })
              }}
              onOpenChange={(open) => { if (open) ensureRoles(m.project_id) }}
            >
              <SelectTrigger className="w-28 h-6 text-xs">
                <SelectValue placeholder="No role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No role</SelectItem>
                {roles.map(r => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => revokeMutation.mutate(m.project_id)}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        )
      })}

      {availableProjects.length > 0 && (
        <Select
          value="__add__"
          onValueChange={async (pid) => {
            if (pid === '__add__') return
            await grantMutation.mutateAsync({ project_id: pid })
          }}
        >
          <SelectTrigger className="h-7 text-xs border-dashed w-full">
            <div className="flex items-center gap-1.5">
              <Plus className="w-3 h-3" />
              <span>Add project access</span>
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__add__" className="hidden">Add project access</SelectItem>
            {availableProjects.map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function CompanyMembersPage({ params }: PageProps) {
  const { company: companySlug } = use(params)
  const qc = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const companyId = companyData?.id ?? ''

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyId],
    queryFn: () => api.projects.list(companyId),
    enabled: !!companyId,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['company-members', companyId],
    queryFn: () => api.acl.listCompanyMembers(companyId),
    enabled: !!companyId,
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.acl.removeCompanyMember(companyId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-members', companyId] })
      toast.success('Member removed')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const members = data?.members ?? []
  const projects = projectsData?.projects ?? []

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {members.length} member{members.length !== 1 ? 's' : ''} · click a member to manage project access
      </p>

      <div className="rounded-lg border divide-y overflow-hidden">
        {members.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No members yet</div>
        )}
        {members.map((m: CompanyMemberItem) => {
          const isExpanded = expandedId === m.user_id
          return (
            <div key={m.id}>
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : m.user_id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{m.user.name}</span>
                    <Badge variant="secondary" className="text-xs py-0">{m.role.name}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {m.user.email} · joined {formatDistanceToNow(new Date(m.joined_at), { addSuffix: true })}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  {!m.role.is_system && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="Remove from company"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Remove ${m.user.name} from this company?`)) {
                          removeMember.mutate(m.user_id)
                        }
                      }}
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {isExpanded
                    ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                    : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  }
                </div>
              </div>

              {isExpanded && (
                <MemberProjectAccess
                  companyId={companyId}
                  userId={m.user_id}
                  projects={projects}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
