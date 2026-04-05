'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { UserPolicy, Policy } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { PolicyRulesTable } from '@/components/permissions/policy-rules-table'
import { UserPolicyList } from '@/components/permissions/user-policy-list'
import { EditMyPermissions } from '@/components/permissions/edit-my-permissions'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, Badge } from '@jiku/ui'
import { Plus, Unlink, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function PermissionsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const user = useAuthStore(s => s.user)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['company', companySlug],
    queryFn: async () => {
      const { companies } = await api.companies.list()
      return companies.find(c => c.slug === companySlug) ?? null
    },
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: agentsData } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })

  const agent = agentsData?.agents.find(a => a.slug === agentSlug)
  const agentId = agent?.id ?? ''

  // Attached policies
  const { data: attachedData } = useQuery({
    queryKey: ['agent-policies', agentId],
    queryFn: () => api.policies.getAgentPolicies(agentId),
  })

  // Company policies (for attach dialog)
  const { data: companyPoliciesData } = useQuery({
    queryKey: ['policies', companyData?.id],
    queryFn: () => api.policies.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  // User policies
  const { data: userPoliciesData } = useQuery({
    queryKey: ['user-policies', agentId],
    queryFn: () => api.policies.getUsers(agentId),
  })

  // Expanded policy rows
  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null)

  // Attach policy dialog
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachPolicyId, setAttachPolicyId] = useState('')

  const attachPolicy = useMutation({
    mutationFn: () => api.policies.attachPolicy(agentId, {
      policy_id: attachPolicyId,
      project_id: project?.id ?? '',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-policies', agentId] })
      toast.success('Policy attached')
      setAttachOpen(false)
      setAttachPolicyId('')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const detachPolicy = useMutation({
    mutationFn: (policyId: string) =>
      api.policies.detachPolicy(agentId, policyId, project?.id ?? ''),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-policies', agentId] })
      toast.success('Policy detached')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  // Create policy + rule in one go
  const [newPolicyOpen, setNewPolicyOpen] = useState(false)
  const [newPolicyName, setNewPolicyName] = useState('')
  const [ruleResourceId, setRuleResourceId] = useState('')
  const [ruleSubjectType, setRuleSubjectType] = useState('permission')
  const [ruleSubject, setRuleSubject] = useState('')
  const [ruleEffect, setRuleEffect] = useState('allow')

  const createAndAttach = useMutation({
    mutationFn: async () => {
      const { policy } = await api.policies.create(companyData!.id, { name: newPolicyName })
      if (ruleResourceId && ruleSubject) {
        await api.policies.createRule(policy.id, {
          policy_id: policy.id,
          resource_type: 'tool',
          resource_id: ruleResourceId,
          subject_type: ruleSubjectType,
          subject: ruleSubject,
          effect: ruleEffect,
          priority: 0,
          conditions: [],
        })
      }
      await api.policies.attachPolicy(agentId, {
        policy_id: policy.id,
        project_id: project?.id ?? '',
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-policies', agentId] })
      qc.invalidateQueries({ queryKey: ['policies', companyData?.id] })
      toast.success('Policy created and attached')
      setNewPolicyOpen(false)
      setNewPolicyName('')
      setRuleResourceId('')
      setRuleSubject('')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  // Edit my permissions state
  const [editPermsOpen, setEditPermsOpen] = useState(false)
  const [editPermsData, setEditPermsData] = useState<{ policy: UserPolicy | null; actualPermissions: string[] } | null>(null)

  function openEditPerms(policy: UserPolicy | null, actualPermissions: string[]) {
    setEditPermsData({ policy, actualPermissions })
    setEditPermsOpen(true)
  }

  const attachedPolicies = attachedData?.policies ?? []
  const companyPolicies = companyPoliciesData?.policies ?? []
  const alreadyAttached = new Set(attachedPolicies.map(ap => ap.policy_id))

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">

      {/* Attached Policies */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Policies</h2>
          <div className="flex gap-2">
            {/* Attach existing policy */}
            <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">Attach Policy</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Attach Existing Policy</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Select Policy</Label>
                    <Select value={attachPolicyId} onValueChange={setAttachPolicyId}>
                      <SelectTrigger><SelectValue placeholder="Choose a policy..." /></SelectTrigger>
                      <SelectContent>
                        {companyPolicies.filter(p => !alreadyAttached.has(p.id)).map(p => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                        {companyPolicies.filter(p => !alreadyAttached.has(p.id)).length === 0 && (
                          <SelectItem value="_none" disabled>No available policies</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setAttachOpen(false)}>Cancel</Button>
                    <Button
                      onClick={() => attachPolicy.mutate()}
                      disabled={attachPolicy.isPending || !attachPolicyId}
                    >
                      {attachPolicy.isPending ? 'Attaching...' : 'Attach'}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {/* Create new policy + attach */}
            <Dialog open={newPolicyOpen} onOpenChange={setNewPolicyOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="w-4 h-4 mr-1" />
                  New Policy
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create &amp; Attach Policy</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Policy Name</Label>
                    <Input
                      value={newPolicyName}
                      onChange={e => setNewPolicyName(e.target.value)}
                      placeholder="e.g. Social Media Rules"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                    Initial Rule (optional)
                  </p>
                  <div className="space-y-2">
                    <Label>Tool / Resource ID</Label>
                    <Input
                      value={ruleResourceId}
                      onChange={e => setRuleResourceId(e.target.value)}
                      placeholder="e.g. jiku.social:create_post"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Subject Type</Label>
                    <Select value={ruleSubjectType} onValueChange={setRuleSubjectType}>
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
                    <Input
                      value={ruleSubject}
                      onChange={e => setRuleSubject(e.target.value)}
                      placeholder="Use * for everyone"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Effect</Label>
                    <Select value={ruleEffect} onValueChange={setRuleEffect}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="allow">Allow</SelectItem>
                        <SelectItem value="deny">Deny</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setNewPolicyOpen(false)}>Cancel</Button>
                    <Button
                      onClick={() => createAndAttach.mutate()}
                      disabled={createAndAttach.isPending || !newPolicyName}
                    >
                      {createAndAttach.isPending ? 'Creating...' : 'Create & Attach'}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {attachedPolicies.length === 0 ? (
          <div className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
            No policies attached. Create or attach one to control tool access.
          </div>
        ) : (
          <div className="space-y-2">
            {attachedPolicies.map(ap => (
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

      {/* User Policies */}
      <section>
        <h2 className="text-base font-semibold mb-3">User Permissions</h2>
        <UserPolicyList
          policies={userPoliciesData?.policies ?? []}
          currentUserId={user?.id}
          onEditMyPermissions={openEditPerms}
        />
      </section>

      {/* Edit My Permissions Modal */}
      {editPermsOpen && user && companyData && agent && (
        <EditMyPermissions
          open={editPermsOpen}
          onClose={() => setEditPermsOpen(false)}
          agentId={agentId}
          userId={user.id}
          companyId={companyData.id}
          agentName={agent.name}
          actualPermissions={editPermsData?.actualPermissions ?? []}
          currentAllowed={editPermsData?.policy?.allowed_permissions ?? []}
        />
      )}
    </div>
  )
}
