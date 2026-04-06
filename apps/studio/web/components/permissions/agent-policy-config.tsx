'use client'

/**
 * AgentPolicyConfig — reusable policy editor for a single agent.
 *
 * Usage (agent settings page):
 *   <AgentPolicyConfig agentId={agentId} companyId={companyId} projectId={projectId} />
 *
 * Usage (project settings policies overview — embed inside an accordion):
 *   <AgentPolicyConfig agentId={agent.id} companyId={companyId} projectId={projectId} compact />
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AgentPolicyItem, UserPolicy } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { PolicyRulesTable } from './policy-rules-table'
import { UserPolicyList } from './user-policy-list'
import { EditMyPermissions } from './edit-my-permissions'
import {
  Button, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
  Badge,
} from '@jiku/ui'
import { Plus, Unlink, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentPolicyConfigProps {
  agentId: string
  companyId: string
  projectId: string
  /** When true: no outer padding, more compact layout — used inside accordions */
  compact?: boolean
}

// ─── Create & Attach Dialog ───────────────────────────────────────────────────

function CreatePolicyDialog({
  agentId,
  companyId,
  projectId,
  onClose,
}: {
  agentId: string
  companyId: string
  projectId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [subjectType, setSubjectType] = useState('permission')
  const [subject, setSubject] = useState('')
  const [effect, setEffect] = useState('allow')

  const createAndAttach = useMutation({
    mutationFn: async () => {
      const { policy } = await api.policies.create(companyId, { name })
      if (resourceId && subject) {
        await api.policies.createRule(policy.id, {
          policy_id: policy.id,
          resource_type: 'tool',
          resource_id: resourceId,
          subject_type: subjectType,
          subject,
          effect,
          priority: 0,
          conditions: [],
        })
      }
      await api.policies.attachPolicy(agentId, { policy_id: policy.id, project_id: projectId })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-policies', agentId] })
      qc.invalidateQueries({ queryKey: ['policies', companyId] })
      toast.success('Policy created and attached')
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create &amp; Attach Policy</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Policy Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Social Media Rules" />
        </div>
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
          Initial Rule (optional)
        </p>
        <div className="space-y-2">
          <Label>Tool / Resource ID</Label>
          <Input value={resourceId} onChange={e => setResourceId(e.target.value)} placeholder="e.g. jiku.social:create_post" />
        </div>
        <div className="space-y-2">
          <Label>Subject Type</Label>
          <Select value={subjectType} onValueChange={setSubjectType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="permission">Permission</SelectItem>
              <SelectItem value="role">Role</SelectItem>
              <SelectItem value="user">User</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Subject</Label>
          <Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Use * for everyone" />
        </div>
        <div className="space-y-2">
          <Label>Effect</Label>
          <Select value={effect} onValueChange={setEffect}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">Allow</SelectItem>
              <SelectItem value="deny">Deny</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => createAndAttach.mutate()} disabled={createAndAttach.isPending || !name.trim()}>
            {createAndAttach.isPending ? 'Creating...' : 'Create & Attach'}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

// ─── Attach Existing Dialog ───────────────────────────────────────────────────

function AttachPolicyDialog({
  agentId,
  companyId,
  projectId,
  alreadyAttached,
  onClose,
}: {
  agentId: string
  companyId: string
  projectId: string
  alreadyAttached: Set<string>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState('')

  const { data: companyPoliciesData } = useQuery({
    queryKey: ['policies', companyId],
    queryFn: () => api.policies.list(companyId),
    enabled: !!companyId,
  })

  const availablePolicies = (companyPoliciesData?.policies ?? []).filter(p => !alreadyAttached.has(p.id))

  const attach = useMutation({
    mutationFn: () => api.policies.attachPolicy(agentId, { policy_id: selectedId, project_id: projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-policies', agentId] })
      toast.success('Policy attached')
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Attach Existing Policy</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Select Policy</Label>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger><SelectValue placeholder="Choose a policy..." /></SelectTrigger>
            <SelectContent>
              {availablePolicies.map(p => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
              {availablePolicies.length === 0 && (
                <SelectItem value="_none" disabled>No available policies</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => attach.mutate()} disabled={attach.isPending || !selectedId}>
            {attach.isPending ? 'Attaching...' : 'Attach'}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AgentPolicyConfig({ agentId, companyId, projectId, compact = false }: AgentPolicyConfigProps) {
  const qc = useQueryClient()
  const user = useAuthStore(s => s.user)

  const { data: attachedData, isLoading } = useQuery({
    queryKey: ['agent-policies', agentId],
    queryFn: () => api.policies.getAgentPolicies(agentId),
    enabled: !!agentId,
  })

  const { data: userPoliciesData } = useQuery({
    queryKey: ['user-policies', agentId],
    queryFn: () => api.policies.getUsers(agentId),
    enabled: !!agentId,
  })

  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editPermsOpen, setEditPermsOpen] = useState(false)
  const [editPermsData, setEditPermsData] = useState<{ policy: UserPolicy | null; actualPermissions: string[] } | null>(null)

  const detachPolicy = useMutation({
    mutationFn: (policyId: string) => api.policies.detachPolicy(agentId, policyId, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-policies', agentId] })
      toast.success('Policy detached')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const attachedPolicies = attachedData?.policies ?? []
  const alreadyAttached = new Set(attachedPolicies.map((ap: AgentPolicyItem) => ap.policy_id))

  const wrapper = compact ? 'space-y-4' : 'space-y-8'

  return (
    <div className={wrapper}>
      {/* Policies section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className={compact ? 'text-sm font-semibold' : 'text-base font-semibold'}>Policies</h3>
            {!compact && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Policies define which tools each caller can use. Rules are evaluated in priority order.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">Attach</Button>
              </DialogTrigger>
              <AttachPolicyDialog
                agentId={agentId}
                companyId={companyId}
                projectId={projectId}
                alreadyAttached={alreadyAttached}
                onClose={() => setAttachOpen(false)}
              />
            </Dialog>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="w-4 h-4 mr-1" />New Policy</Button>
              </DialogTrigger>
              <CreatePolicyDialog
                agentId={agentId}
                companyId={companyId}
                projectId={projectId}
                onClose={() => setCreateOpen(false)}
              />
            </Dialog>
          </div>
        </div>

        {isLoading ? (
          <div className="rounded-md border px-4 py-6 text-center text-sm text-muted-foreground">Loading...</div>
        ) : attachedPolicies.length === 0 ? (
          <div className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
            No policies attached. Tools are unrestricted by default.
          </div>
        ) : (
          <div className="space-y-2">
            {attachedPolicies.map((ap: AgentPolicyItem) => (
              <div key={ap.policy_id} className="rounded-md border">
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
                  onClick={() => setExpandedPolicy(expandedPolicy === ap.policy_id ? null : ap.policy_id)}
                >
                  <div className="flex items-center gap-2">
                    {expandedPolicy === ap.policy_id
                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    }
                    <span className="font-medium text-sm">{ap.policy.name}</span>
                    {ap.policy.is_template && (
                      <Badge variant="secondary" className="text-xs">template</Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {ap.policy.rules.length} rule{ap.policy.rules.length !== 1 ? 's' : ''}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); detachPolicy.mutate(ap.policy_id) }}
                  >
                    <Unlink className="w-3.5 h-3.5" />
                  </Button>
                </div>
                {expandedPolicy === ap.policy_id && (
                  <div className="border-t px-4 py-3">
                    <PolicyRulesTable policyId={ap.policy_id} rules={ap.policy.rules} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* User permissions section */}
      <section>
        <h3 className={compact ? 'text-sm font-semibold mb-3' : 'text-base font-semibold mb-3'}>
          User Permissions
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Each user can self-restrict which tools they allow this agent to use on their behalf.
        </p>
        <UserPolicyList
          policies={userPoliciesData?.policies ?? []}
          currentUserId={user?.id}
          onEditMyPermissions={(policy, actualPermissions) => {
            setEditPermsData({ policy, actualPermissions })
            setEditPermsOpen(true)
          }}
        />
      </section>

      {/* Edit My Permissions dialog */}
      {editPermsOpen && user && editPermsData && (
        <EditMyPermissions
          open={editPermsOpen}
          onClose={() => setEditPermsOpen(false)}
          agentId={agentId}
          userId={user.id}
          companyId={companyId}
          agentName=""
          actualPermissions={editPermsData.actualPermissions}
          currentAllowed={editPermsData.policy?.allowed_permissions ?? []}
        />
      )}
    </div>
  )
}
