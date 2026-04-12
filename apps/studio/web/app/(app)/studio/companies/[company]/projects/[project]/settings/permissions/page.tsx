'use client'

import { use, useState } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ProjectRole, ProjectMember, Agent } from '@/lib/api'
import { PERMISSIONS, ROLE_PRESETS } from '@jiku/types'
import {
  Button, Input, Label, Badge, Separator, Switch,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@jiku/ui'
import { Plus, Trash2, Star, UserMinus, Shield, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

// ─── Permission groups for the role editor ─────────────────────────────────────

const PERMISSION_GROUPS: { label: string; perms: { key: string; label: string }[] }[] = [
  {
    label: 'Chats',
    perms: [
      { key: PERMISSIONS.CHATS_READ, label: 'View conversations' },
      { key: PERMISSIONS.CHATS_CREATE, label: 'Start conversations' },
    ],
  },
  {
    label: 'Memory',
    perms: [
      { key: PERMISSIONS.MEMORY_READ, label: 'View memory' },
      { key: PERMISSIONS.MEMORY_WRITE, label: 'Add memory' },
      { key: PERMISSIONS.MEMORY_DELETE, label: 'Delete memory' },
    ],
  },
  {
    label: 'Runs',
    perms: [{ key: PERMISSIONS.RUNS_READ, label: 'View run history' }],
  },
  {
    label: 'Agents',
    perms: [
      { key: PERMISSIONS.AGENTS_READ, label: 'View agents' },
      { key: PERMISSIONS.AGENTS_WRITE, label: 'Edit agent settings' },
      { key: PERMISSIONS.AGENTS_CREATE, label: 'Create agents' },
      { key: PERMISSIONS.AGENTS_DELETE, label: 'Delete agents' },
    ],
  },
  {
    label: 'Channels',
    perms: [
      { key: PERMISSIONS.CHANNELS_READ, label: 'View channels' },
      { key: PERMISSIONS.CHANNELS_WRITE, label: 'Manage connectors' },
    ],
  },
  {
    label: 'Plugins',
    perms: [
      { key: PERMISSIONS.PLUGINS_READ, label: 'View plugins' },
      { key: PERMISSIONS.PLUGINS_WRITE, label: 'Enable / disable plugins' },
    ],
  },
  {
    label: 'Settings',
    perms: [
      { key: PERMISSIONS.SETTINGS_READ, label: 'View project settings' },
      { key: PERMISSIONS.SETTINGS_WRITE, label: 'Edit project settings' },
    ],
  },
  {
    label: 'Members & Roles',
    perms: [
      { key: PERMISSIONS.MEMBERS_READ, label: 'View members' },
      { key: PERMISSIONS.MEMBERS_WRITE, label: 'Invite / remove members' },
      { key: PERMISSIONS.ROLES_WRITE, label: 'Create / edit roles' },
    ],
  },
]

// ─── Role Editor Dialog ────────────────────────────────────────────────────────

function RoleEditorDialog({
  projectId,
  role,
  onClose,
}: {
  projectId: string
  role: ProjectRole | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [permissions, setPermissions] = useState<Set<string>>(new Set(role?.permissions ?? []))
  const [isDefault, setIsDefault] = useState(role?.is_default ?? false)

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: [...permissions],
        is_default: isDefault,
      }
      if (role) return api.acl.updateRole(projectId, role.id, body)
      return api.acl.createRole(projectId, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['acl-roles', projectId] })
      toast.success(role ? 'Role updated' : 'Role created')
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.acl.deleteRole(projectId, role!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['acl-roles', projectId] })
      toast.success('Role deleted')
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  function togglePerm(key: string) {
    setPermissions(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{role ? `Edit Role: ${role.name}` : 'New Role'}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Manager, Viewer" />
        </div>
        <div className="space-y-1.5">
          <Label>Description</Label>
          <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="is-default" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} className="rounded" />
          <Label htmlFor="is-default" className="cursor-pointer text-sm">Default role for new invited users</Label>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-muted-foreground">Import preset:</span>
          {(Object.keys(ROLE_PRESETS) as (keyof typeof ROLE_PRESETS)[]).map((key) => (
            <Button key={key} variant="outline" size="sm" className="h-6 text-xs" onClick={() => setPermissions(new Set(ROLE_PRESETS[key].permissions))}>
              {ROLE_PRESETS[key].name}
            </Button>
          ))}
        </div>

        <Separator />

        <div className="space-y-4">
          <Label className="text-sm font-semibold">Permissions ({permissions.size} selected)</Label>
          {PERMISSION_GROUPS.map(group => (
            <div key={group.label} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{group.label}</p>
              <div className="grid grid-cols-2 gap-1">
                {group.perms.map(perm => (
                  <label key={perm.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input type="checkbox" checked={permissions.has(perm.key)} onChange={() => togglePerm(perm.key)} className="rounded" />
                    {perm.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-between pt-2">
          {role && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (confirm('Delete this role?')) deleteMutation.mutate() }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !name.trim()}>
              {saveMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </DialogContent>
  )
}

// ─── Invite Dialog ─────────────────────────────────────────────────────────────

function InviteDialog({
  projectId,
  companyId,
  roles,
  onClose,
}: {
  projectId: string
  companyId: string
  roles: ProjectRole[]
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState<string>('')

  const sendMutation = useMutation({
    mutationFn: () => api.acl.sendInvitation(companyId, {
      email: email.trim(),
      project_grants: roleId ? [{ project_id: projectId, role_id: roleId }] : [],
    }),
    onSuccess: () => {
      toast.success(`Invitation sent to ${email}`)
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to send'),
  })

  return (
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Invite Member</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Email</Label>
          <Input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="user@example.com" />
        </div>
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger><SelectValue placeholder="Select a role (optional)" /></SelectTrigger>
            <SelectContent>
              {roles.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending || !email.trim()}>
            {sendMutation.isPending ? 'Sending...' : 'Send Invite'}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function ProjectPermissionsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })

  const projectId = projectData?.id ?? ''
  const companyId = companyData?.id ?? ''

  const { data: rolesData } = useQuery({
    queryKey: ['acl-roles', projectId],
    queryFn: () => api.acl.listRoles(projectId),
    enabled: !!projectId,
  })

  const { data: membersData } = useQuery({
    queryKey: ['acl-members', projectId],
    queryFn: () => api.acl.listMembers(projectId),
    enabled: !!projectId,
  })

  const { data: myPerms } = useQuery({
    queryKey: ['acl-my-perms', projectId],
    queryFn: () => api.acl.getMyPermissions(projectId),
    enabled: !!projectId,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api.agents.list(projectId),
    enabled: !!projectId,
  })

  const roles = rolesData?.roles ?? []
  const members = membersData?.members ?? []
  const agents = agentsData?.agents ?? []

  const [roleEditorRole, setRoleEditorRole] = useState<ProjectRole | null | 'new'>(null)
  const [showInvite, setShowInvite] = useState(false)
  const [agentAccessMemberId, setAgentAccessMemberId] = useState<string | null>(null)

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.acl.removeMember(projectId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['acl-members', projectId] })
      toast.success('Member removed')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const setSuperadmin = useMutation({
    mutationFn: ({ userId, grant }: { userId: string; grant: boolean }) =>
      api.acl.setSuperadmin(projectId, userId, grant),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['acl-members', projectId] })
      toast.success('Updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const assignRole = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.acl.assignRole(projectId, userId, roleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['acl-members', projectId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const setAgentRestrictions = useMutation({
    mutationFn: ({ userId, restrictions }: { userId: string; restrictions: Record<string, boolean> }) =>
      api.acl.setAgentRestrictions(projectId, userId, restrictions),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['acl-members', projectId] })
      toast.success('Agent access updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const isSuperadmin = myPerms?.isSuperadmin ?? false
  // Show buttons while loading (myPerms undefined) or when superadmin
  // Only hide if loaded AND explicitly no permission
  const permsLoaded = myPerms != null
  const canManageMembers = !permsLoaded || isSuperadmin || myPerms.permissions.includes('members:write')
  const canManageRoles = !permsLoaded || isSuperadmin || myPerms.permissions.includes('roles:write')

  if (!projectData) return <div className="text-sm text-muted-foreground p-4">Loading...</div>

  const urlTab = searchParams.get('tab')
  const activeTab = urlTab === 'roles' ? 'roles' : urlTab === 'agents' ? 'agent-access' : 'members'
  const setActiveTab = (v: string) => {
    const p = new URLSearchParams(searchParams.toString())
    if (v === 'members') p.delete('tab')
    else if (v === 'roles') p.set('tab', 'roles')
    else if (v === 'agent-access') p.set('tab', 'agents')
    router.replace(`${pathname}${p.toString() ? `?${p.toString()}` : ''}`)
  }

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="agent-access">Agent Access</TabsTrigger>
        </TabsList>

        {/* Members Tab */}
        <TabsContent value="members" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{members.length} member{members.length !== 1 ? 's' : ''}</p>
            {canManageMembers && (
              <Dialog open={showInvite} onOpenChange={setShowInvite}>
                <DialogTrigger asChild>
                  <Button size="sm"><Plus className="w-3.5 h-3.5 mr-1" />Invite</Button>
                </DialogTrigger>
                <InviteDialog projectId={projectId} companyId={companyId} roles={roles} onClose={() => setShowInvite(false)} />
              </Dialog>
            )}
          </div>

          <div className="rounded-lg border divide-y">
            {members.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">No members yet</div>
            )}
            {members.map((m: ProjectMember) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{m.user.name}</span>
                    {m.is_superadmin && (
                      <Badge variant="secondary" className="gap-1 text-xs py-0">
                        <Star className="w-2.5 h-2.5 fill-yellow-400 text-yellow-400" /> Superadmin
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{m.user.email}</p>
                </div>

                {canManageMembers ? (
                  <Select
                    value={m.role_id ?? '__none__'}
                    onValueChange={(val) => {
                      if (val !== '__none__') assignRole.mutate({ userId: m.user_id, roleId: val })
                    }}
                  >
                    <SelectTrigger className="w-32 h-7 text-xs">
                      <SelectValue placeholder="No role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No role</SelectItem>
                      {roles.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  m.role && <Badge variant="outline" className="text-xs">{m.role.name}</Badge>
                )}

                {isSuperadmin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    title={m.is_superadmin ? 'Revoke superadmin' : 'Grant superadmin'}
                    onClick={() => setSuperadmin.mutate({ userId: m.user_id, grant: !m.is_superadmin })}
                  >
                    <Star className={`w-3.5 h-3.5 ${m.is_superadmin ? 'fill-yellow-400 text-yellow-400' : ''}`} />
                  </Button>
                )}

                {canManageMembers && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => { if (confirm(`Remove ${m.user.name} from this project?`)) removeMember.mutate(m.user_id) }}
                  >
                    <UserMinus className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </TabsContent>

        {/* Roles Tab */}
        <TabsContent value="roles" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{roles.length} role{roles.length !== 1 ? 's' : ''}</p>
            {canManageRoles && (
              <Dialog open={roleEditorRole === 'new'} onOpenChange={open => !open && setRoleEditorRole(null)}>
                <DialogTrigger asChild>
                  <Button size="sm" onClick={() => setRoleEditorRole('new')}><Plus className="w-3.5 h-3.5 mr-1" />New Role</Button>
                </DialogTrigger>
                {roleEditorRole === 'new' && (
                  <RoleEditorDialog projectId={projectId} role={null} onClose={() => setRoleEditorRole(null)} />
                )}
              </Dialog>
            )}
          </div>

          <div className="rounded-lg border divide-y">
            {roles.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No custom roles yet. Create one or import a preset.
              </div>
            )}
            {roles.map((role: ProjectRole) => (
              <div key={role.id} className="flex items-center gap-3 px-4 py-3">
                <Shield className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{role.name}</span>
                    {role.is_default && <Badge variant="secondary" className="text-xs py-0">Default</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {role.permissions.length} permission{role.permissions.length !== 1 ? 's' : ''}
                    {(role.member_count ?? 0) > 0 && ` · ${role.member_count} member${role.member_count !== 1 ? 's' : ''}`}
                  </p>
                </div>
                {canManageRoles && (
                  <Dialog
                    open={roleEditorRole !== null && roleEditorRole !== 'new' && (roleEditorRole as ProjectRole).id === role.id}
                    onOpenChange={open => !open && setRoleEditorRole(null)}
                  >
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-xs" onClick={() => setRoleEditorRole(role)}>Edit</Button>
                    </DialogTrigger>
                    {roleEditorRole !== null && roleEditorRole !== 'new' && (roleEditorRole as ProjectRole).id === role.id && (
                      <RoleEditorDialog projectId={projectId} role={role} onClose={() => setRoleEditorRole(null)} />
                    )}
                  </Dialog>
                )}
              </div>
            ))}
          </div>
        </TabsContent>

        {/* Agent Access Tab */}
        <TabsContent value="agent-access" className="space-y-4 mt-4">
          <p className="text-sm text-muted-foreground">
            Control which agents each member can see and use. Hidden agents are invisible to the member — they won&apos;t appear in the sidebar or chat selector. Superadmins and members with <code className="text-xs bg-muted px-1 rounded">agents:write</code> always see all agents.
          </p>

          {agents.length === 0 && (
            <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
              No agents in this project yet.
            </div>
          )}

          {agents.length > 0 && (
            <div className="rounded-lg border divide-y">
              {members.map((m: ProjectMember) => {
                const restrictions: Record<string, boolean> = (m.agent_restrictions as Record<string, boolean>) ?? {}
                // Superadmins always see everything — no per-agent restriction applies
                const isMemberSuperadmin = m.is_superadmin
                const hiddenCount = agents.filter(a => restrictions[a.id] === false).length
                const isExpanded = agentAccessMemberId === m.user_id

                return (
                  <div key={m.user_id} className="px-4 py-3">
                    {/* Member header row */}
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{m.user.name}</span>
                          {isMemberSuperadmin && (
                            <Badge variant="secondary" className="gap-1 text-xs py-0">
                              <Star className="w-2.5 h-2.5 fill-yellow-400 text-yellow-400" /> Superadmin
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {isMemberSuperadmin
                            ? 'Sees all agents (superadmin)'
                            : hiddenCount > 0
                              ? `${agents.length - hiddenCount} of ${agents.length} agents visible`
                              : `All ${agents.length} agents visible`}
                        </p>
                      </div>
                      {!isMemberSuperadmin && canManageMembers && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 gap-1"
                          onClick={() => setAgentAccessMemberId(isExpanded ? null : m.user_id)}
                        >
                          {isExpanded ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          {isExpanded ? 'Close' : 'Edit'}
                        </Button>
                      )}
                    </div>

                    {/* Expanded agent toggle list */}
                    {isExpanded && !isMemberSuperadmin && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {agents.map((agent: Agent) => {
                          const visible = restrictions[agent.id] !== false
                          return (
                            <div key={agent.id} className="flex items-center justify-between rounded-md border px-3 py-2 gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{agent.name}</p>
                                {agent.description && (
                                  <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                                )}
                              </div>
                              <Switch
                                checked={visible}
                                onCheckedChange={(checked) => {
                                  const next = { ...restrictions }
                                  if (checked) {
                                    delete next[agent.id] // remove restriction = visible
                                  } else {
                                    next[agent.id] = false // explicitly hidden
                                  }
                                  setAgentRestrictions.mutate({ userId: m.user_id, restrictions: next })
                                }}
                              />
                            </div>
                          )
                        })}
                        <div className="sm:col-span-2 flex gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => {
                              const all = Object.fromEntries(agents.map(a => [a.id, false]))
                              setAgentRestrictions.mutate({ userId: m.user_id, restrictions: all })
                            }}
                          >
                            Hide all
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => setAgentRestrictions.mutate({ userId: m.user_id, restrictions: {} })}
                          >
                            Show all
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
