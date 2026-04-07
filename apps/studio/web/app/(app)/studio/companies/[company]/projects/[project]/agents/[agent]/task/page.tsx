'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Switch, cn } from '@jiku/ui'
import { Bot, Clock, ShieldCheck, ShieldOff, Users } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

type DelegationMode = 'allow_all' | 'deny_all' | 'specific'

function getDelegationMode(task_allowed_agents: string[] | null | undefined): DelegationMode {
  if (task_allowed_agents === null || task_allowed_agents === undefined) return 'allow_all'
  if (task_allowed_agents.length === 0) return 'deny_all'
  return 'specific'
}

export default function AgentTaskPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const queryClient = useQueryClient()

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

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id,
  })

  const currentAgent = agentsData?.agents.find(a => a.slug === agentSlug)
  const otherAgents = agentsData?.agents.filter(a => a.slug !== agentSlug) ?? []

  const [localAllowed, setLocalAllowed] = useState<string[] | null | undefined>(undefined)
  const effectiveAllowed = localAllowed !== undefined ? localAllowed : currentAgent?.task_allowed_agents
  const mode = getDelegationMode(effectiveAllowed)
  const isDirty = localAllowed !== undefined

  const updateMutation = useMutation({
    mutationFn: (task_allowed_agents: string[] | null) =>
      api.agents.update(currentAgent!.id, { task_allowed_agents }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', projectData?.id] })
      setLocalAllowed(undefined)
    },
  })

  const cronEnabledMutation = useMutation({
    mutationFn: (cron_task_enabled: boolean) =>
      api.agents.update(currentAgent!.id, { cron_task_enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', projectData?.id] })
      toast.success('Cron task setting saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  function setMode(next: DelegationMode) {
    if (next === 'allow_all') setLocalAllowed(null)
    else if (next === 'deny_all') setLocalAllowed([])
    else setLocalAllowed(Array.isArray(effectiveAllowed) && effectiveAllowed.length > 0 ? effectiveAllowed : [])
  }

  function toggleAgent(agentId: string) {
    const cur = Array.isArray(effectiveAllowed) ? effectiveAllowed : []
    setLocalAllowed(cur.includes(agentId) ? cur.filter(id => id !== agentId) : [...cur, agentId])
  }

  if (!currentAgent) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  const cronTaskEnabled = currentAgent.cron_task_enabled !== false

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      {/* Cron Task Access */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Clock className="h-4 w-4" />
            Cron Task Access
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Allow this agent to be used as the target of cron tasks.
          </p>
        </div>
        <div className="flex items-center justify-between border rounded-lg p-4">
          <div>
            <p className="text-sm font-medium">Enable Cron Tasks</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              When enabled, this agent can be selected when creating cron tasks
            </p>
          </div>
          <Switch
            checked={cronTaskEnabled}
            onCheckedChange={(val) => cronEnabledMutation.mutate(val)}
            disabled={cronEnabledMutation.isPending}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Task Delegation</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Control which agents this agent can delegate tasks to via{' '}
            <code className="font-mono text-[11px]">run_task</code>.
          </p>
        </div>

        <div className="space-y-2">
          <button
            onClick={() => setMode('allow_all')}
            className={cn(
              'w-full flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
              mode === 'allow_all' ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/40',
            )}
          >
            <Users className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Allow all agents</p>
              <p className="text-xs text-muted-foreground">Can delegate tasks to any agent in this project</p>
            </div>
            {mode === 'allow_all' && <Badge className="ml-auto shrink-0 text-[10px]">active</Badge>}
          </button>

          <button
            onClick={() => setMode('deny_all')}
            className={cn(
              'w-full flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
              mode === 'deny_all' ? 'border-destructive bg-destructive/5' : 'border-border/50 hover:bg-muted/40',
            )}
          >
            <ShieldOff className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Deny all</p>
              <p className="text-xs text-muted-foreground">Cannot delegate tasks to any agent</p>
            </div>
            {mode === 'deny_all' && <Badge variant="destructive" className="ml-auto shrink-0 text-[10px]">active</Badge>}
          </button>

          <button
            onClick={() => setMode('specific')}
            className={cn(
              'w-full flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
              mode === 'specific' ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/40',
            )}
          >
            <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Specific agents</p>
              <p className="text-xs text-muted-foreground">Only allow delegation to selected agents below</p>
            </div>
            {mode === 'specific' && <Badge className="ml-auto shrink-0 text-[10px]">active</Badge>}
          </button>
        </div>

        {mode === 'specific' && (
          <div className="border border-border/40 rounded-lg divide-y divide-border/30">
            {otherAgents.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">No other agents in this project.</p>
            ) : (
              otherAgents.map(a => {
                const selected = Array.isArray(effectiveAllowed) && effectiveAllowed.includes(a.id)
                return (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      {a.description && (
                        <p className="text-xs text-muted-foreground truncate">{a.description}</p>
                      )}
                    </div>
                    <Switch checked={selected} onCheckedChange={() => toggleAgent(a.id)} />
                  </div>
                )
              })
            )}
          </div>
        )}

        {isDirty && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setLocalAllowed(undefined)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateMutation.mutate(effectiveAllowed ?? null)}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
