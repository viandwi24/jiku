'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { InvitationItem, Project, ProjectRole } from '@/lib/api'
import {
  Button, Input, Label, Badge, Checkbox,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  ScrollArea,
} from '@jiku/ui'
import { Plus, X, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'

interface PageProps {
  params: Promise<{ company: string }>
}

const STATUS_BADGE: Record<InvitationItem['status'], { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  pending:   { label: 'Pending',   variant: 'secondary' },
  accepted:  { label: 'Accepted',  variant: 'outline' },
  declined:  { label: 'Declined',  variant: 'destructive' },
  expired:   { label: 'Expired',   variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
}

// ─── Per-project grant row ─────────────────────────────────────────────────────

interface ProjectGrantRow {
  projectId: string
  roleId: string  // '' means no role (company member only)
}

function ProjectGrantEditor({
  grant,
  projects,
  roles,
  onChange,
  onRemove,
}: {
  grant: ProjectGrantRow
  projects: Project[]
  roles: Record<string, ProjectRole[]>  // projectId → roles
  onChange: (g: ProjectGrantRow) => void
  onRemove: () => void
}) {
  const projectRoles = grant.projectId ? (roles[grant.projectId] ?? []) : []

  return (
    <div className="flex items-center gap-2">
      <Select
        value={grant.projectId}
        onValueChange={pid => onChange({ projectId: pid, roleId: '' })}
      >
        <SelectTrigger className="flex-1 h-8 text-xs">
          <SelectValue placeholder="Select project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map(p => (
            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={grant.roleId || '__none__'}
        onValueChange={rid => onChange({ ...grant, roleId: rid === '__none__' ? '' : rid })}
        disabled={!grant.projectId}
      >
        <SelectTrigger className="w-32 h-8 text-xs">
          <SelectValue placeholder="No role" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">No role</SelectItem>
          {projectRoles.map(r => (
            <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onRemove}>
        <X className="w-3 h-3" />
      </Button>
    </div>
  )
}

// ─── Send Invite Dialog ────────────────────────────────────────────────────────

function SendInviteDialog({
  companyId,
  projects,
  onClose,
}: {
  companyId: string
  projects: Project[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [allProjects, setAllProjects] = useState(false)
  const [grants, setGrants] = useState<ProjectGrantRow[]>([])
  const [rolesCache, setRolesCache] = useState<Record<string, ProjectRole[]>>({})

  // Fetch roles for a project when it's selected
  async function ensureRoles(projectId: string) {
    if (!projectId || rolesCache[projectId]) return
    try {
      const data = await api.acl.listRoles(projectId)
      setRolesCache(prev => ({ ...prev, [projectId]: data.roles }))
    } catch {
      // ignore
    }
  }

  function addGrant() {
    setGrants(prev => [...prev, { projectId: '', roleId: '' }])
  }

  function updateGrant(idx: number, g: ProjectGrantRow) {
    setGrants(prev => prev.map((r, i) => i === idx ? g : r))
    if (g.projectId) ensureRoles(g.projectId)
  }

  function removeGrant(idx: number) {
    setGrants(prev => prev.filter((_, i) => i !== idx))
  }

  // Build final project_grants: all-projects flag creates one entry per project with no role
  const finalGrants = allProjects
    ? projects.map(p => ({ project_id: p.id, role_id: '' }))
    : grants
        .filter(g => g.projectId)
        .map(g => ({ project_id: g.projectId, role_id: g.roleId }))

  const sendMutation = useMutation({
    mutationFn: () =>
      api.acl.sendInvitation(companyId, {
        email: email.trim(),
        project_grants: finalGrants,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-invitations', companyId] })
      toast.success(`Invitation sent to ${email}`)
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to send invitation'),
  })

  // Projects already added as a grant
  const selectedProjectIds = new Set(grants.map(g => g.projectId).filter(Boolean))
  const availableProjects = projects.filter(p => !selectedProjectIds.has(p.id))

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Send Invitation</DialogTitle>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Email address</Label>
          <Input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            placeholder="user@example.com"
          />
        </div>

        <div className="space-y-2">
          <Label>Project access</Label>

          {/* All projects toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none rounded-md border px-3 py-2 text-sm">
            <Checkbox
              checked={allProjects}
              onCheckedChange={(v) => {
                setAllProjects(!!v)
                if (v) setGrants([])
              }}
            />
            <span className="font-medium">All projects</span>
            <span className="text-muted-foreground text-xs ml-auto">grant access to every project</span>
          </label>

          {/* Per-project grants */}
          {!allProjects && (
            <div className="space-y-2">
              {grants.map((g, i) => (
                <ProjectGrantEditor
                  key={i}
                  grant={g}
                  projects={availableProjects.concat(projects.filter(p => p.id === g.projectId))}
                  roles={rolesCache}
                  onChange={updated => updateGrant(i, updated)}
                  onRemove={() => removeGrant(i)}
                />
              ))}
              {availableProjects.length > 0 && (
                <Button variant="outline" size="sm" className="h-7 text-xs w-full" onClick={addGrant}>
                  <Plus className="w-3 h-3 mr-1" /> Add project
                </Button>
              )}
              {grants.length === 0 && (
                <p className="text-xs text-muted-foreground">No project access — company member only.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !email.trim()}
          >
            {sendMutation.isPending ? 'Sending...' : 'Send Invite'}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function CompanyInvitationsPage({ params }: PageProps) {
  const { company: companySlug } = use(params)
  const qc = useQueryClient()
  const [showDialog, setShowDialog] = useState(false)

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
    queryKey: ['company-invitations', companyId],
    queryFn: () => api.acl.listCompanyInvitations(companyId),
    enabled: !!companyId,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.acl.cancelInvitation(companyId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-invitations', companyId] })
      toast.success('Invitation cancelled')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const invitations = data?.invitations ?? []
  const projects = projectsData?.projects ?? []

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {invitations.length} invitation{invitations.length !== 1 ? 's' : ''}
        </p>
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="w-3.5 h-3.5 mr-1" />
              Invite
            </Button>
          </DialogTrigger>
          <SendInviteDialog
            companyId={companyId}
            projects={projects}
            onClose={() => setShowDialog(false)}
          />
        </Dialog>
      </div>

      <div className="rounded-lg border divide-y">
        {invitations.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No invitations sent yet
          </div>
        )}
        {invitations.map((inv: InvitationItem) => {
          const badge = STATUS_BADGE[inv.status]
          const isPending = inv.status === 'pending'
          const grantCount = inv.project_grants?.length ?? 0
          return (
            <div key={inv.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{inv.email}</span>
                  <Badge variant={badge.variant} className="text-xs py-0">{badge.label}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {grantCount > 0
                    ? `${grantCount} project${grantCount !== 1 ? 's' : ''} · `
                    : 'Company only · '}
                  {isPending
                    ? `expires ${formatDistanceToNow(new Date(inv.expires_at), { addSuffix: true })}`
                    : `sent ${formatDistanceToNow(new Date(inv.created_at), { addSuffix: true })}`}
                </p>
              </div>
              {isPending && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  title="Cancel invitation"
                  onClick={() => {
                    if (confirm(`Cancel invitation for ${inv.email}?`)) {
                      cancelMutation.mutate(inv.id)
                    }
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
