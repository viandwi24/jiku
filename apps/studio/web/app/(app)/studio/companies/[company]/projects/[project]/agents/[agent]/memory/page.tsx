'use client'

import { use, useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AgentMemoryConfig, ResolvedMemoryConfig } from '@/lib/api'
import { Badge, Button, Label, Separator, Switch } from '@jiku/ui'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

type InheritOrBool = 'inherit' | 'on' | 'off'

function toBool(val: InheritOrBool, fallback: boolean): boolean | undefined {
  if (val === 'inherit') return undefined
  return val === 'on'
}

function toInherit(val: boolean | undefined | null): InheritOrBool {
  if (val === null || val === undefined) return 'inherit'
  return val ? 'on' : 'off'
}

function InheritToggle({
  label,
  description,
  value,
  onChange,
  resolved,
  resolvedSource,
}: {
  label: string
  description?: string
  value: InheritOrBool
  onChange: (v: InheritOrBool) => void
  resolved: boolean
  resolvedSource: 'project' | 'agent'
}) {
  const options: InheritOrBool[] = ['inherit', 'on', 'off']
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-xs text-muted-foreground">
            Effective: <span className="font-medium text-foreground">{resolved ? 'on' : 'off'}</span>
          </span>
          <Badge variant={resolvedSource === 'agent' ? 'default' : 'secondary'} className="text-[10px] px-1 py-0 h-4">
            {resolvedSource}
          </Badge>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {options.map(opt => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              value === opt
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function AgentMemoryPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
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

  const { data: resolvedData, isLoading } = useQuery({
    queryKey: ['agent-memory-config-resolved', agentId],
    queryFn: () => api.memoryConfig.getAgentResolved(agentId),
    enabled: !!agentId,
  })

  const resolved = resolvedData?.resolved
  const agentConfig = resolvedData?.agent_config
  const projectConfig = resolvedData?.project_config

  // Local state for policy overrides
  const [readRuntime, setReadRuntime] = useState<InheritOrBool>('inherit')
  const [writeRuntime, setWriteRuntime] = useState<InheritOrBool>('inherit')
  const [crossUserRead, setCrossUserRead] = useState<InheritOrBool>('inherit')
  const [extractionEnabled, setExtractionEnabled] = useState<InheritOrBool>('inherit')

  // Sync form state whenever fresh data arrives from the server
  useEffect(() => {
    if (!resolvedData) return
    setReadRuntime(toInherit(resolvedData.agent_config?.policy?.read?.runtime_global ?? null))
    setWriteRuntime(toInherit(resolvedData.agent_config?.policy?.write?.runtime_global ?? null))
    setCrossUserRead(toInherit(resolvedData.agent_config?.policy?.read?.cross_user ?? null))
    setExtractionEnabled(toInherit(resolvedData.agent_config?.extraction?.enabled ?? null))
  }, [resolvedData])

  const saveMutation = useMutation({
    mutationFn: () => {
      const policy = {
        read: {
          ...(readRuntime !== 'inherit' ? { runtime_global: readRuntime === 'on' } : {}),
          ...(crossUserRead !== 'inherit' ? { cross_user: crossUserRead === 'on' } : {}),
        },
        write: {
          ...(writeRuntime !== 'inherit' ? { runtime_global: writeRuntime === 'on' } : {}),
        },
      }
      const extraction = extractionEnabled !== 'inherit'
        ? { enabled: extractionEnabled === 'on' }
        : undefined

      const hasPolicy = Object.keys(policy.read).length > 0 || Object.keys(policy.write).length > 0
      const config: AgentMemoryConfig | null = (hasPolicy || extraction)
        ? {
            ...(hasPolicy ? { policy } : {}),
            ...(extraction ? { extraction } : {}),
          }
        : null

      return api.memoryConfig.updateAgent(agentId, config)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-memory-config-resolved', agentId] })
      toast.success('Memory config saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const resetMutation = useMutation({
    mutationFn: () => api.memoryConfig.updateAgent(agentId, null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-memory-config-resolved', agentId] })
      toast.success('Reset to project defaults')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to reset'),
  })

  if (isLoading || !resolved || !projectConfig) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  const sourceOf = (field: keyof AgentMemoryConfig): 'agent' | 'project' =>
    agentConfig && (agentConfig as Record<string, unknown>)[field] !== undefined ? 'agent' : 'project'

  const policyReadSource = (key: 'runtime_global' | 'cross_user'): 'agent' | 'project' =>
    agentConfig?.policy?.read && (agentConfig.policy.read as Record<string, unknown>)[key] !== undefined ? 'agent' : 'project'

  const policyWriteSource = (key: 'runtime_global'): 'agent' | 'project' =>
    agentConfig?.policy?.write && (agentConfig.policy.write as Record<string, unknown>)[key] !== undefined ? 'agent' : 'project'

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <p className="text-sm font-medium">memory config</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Override project memory defaults for this agent. Leave fields as <span className="font-mono">inherit</span> to use project defaults.
        </p>
      </div>

      {/* Policy — Read */}
      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Read Policy</p>
        <InheritToggle
          label="Read project memory"
          description="Agent can read runtime_global memories shared across all agents."
          value={readRuntime}
          onChange={setReadRuntime}
          resolved={resolved.policy.read.runtime_global}
          resolvedSource={policyReadSource('runtime_global')}
        />
        <InheritToggle
          label="Cross-user read"
          description="Agent can read agent_shared memories belonging to other users."
          value={crossUserRead}
          onChange={setCrossUserRead}
          resolved={resolved.policy.read.cross_user}
          resolvedSource={policyReadSource('cross_user')}
        />
      </div>

      <Separator />

      {/* Policy — Write */}
      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Write Policy</p>
        <InheritToggle
          label="Write project memory"
          description="Agent can write to runtime_global memories visible to all agents."
          value={writeRuntime}
          onChange={setWriteRuntime}
          resolved={resolved.policy.write.runtime_global}
          resolvedSource={policyWriteSource('runtime_global')}
        />
      </div>

      <Separator />

      {/* Extraction */}
      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Extraction</p>
        <InheritToggle
          label="Post-run extraction"
          description="Automatically extract and store facts after each conversation turn using a small LLM."
          value={extractionEnabled}
          onChange={setExtractionEnabled}
          resolved={resolved.extraction.enabled}
          resolvedSource={sourceOf('extraction')}
        />
      </div>

      <Separator />

      {/* Effective Config Panel */}
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Effective Config</p>
        <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs space-y-1">
          {([
            ['read.runtime_global', resolved.policy.read.runtime_global, policyReadSource('runtime_global')],
            ['read.cross_user', resolved.policy.read.cross_user, policyReadSource('cross_user')],
            ['write.runtime_global', resolved.policy.write.runtime_global, policyWriteSource('runtime_global')],
            ['extraction.enabled', resolved.extraction.enabled, sourceOf('extraction')],
            ['relevance.max_extended', resolved.relevance.max_extended, 'project'],
            ['core.token_budget', resolved.core.token_budget, 'project'],
          ] as [string, boolean | number, string][]).map(([key, val, src]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{key}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-foreground">{String(val)}</span>
                <Badge variant={src === 'agent' ? 'default' : 'secondary'} className="text-[10px] px-1 py-0 h-4">
                  {src}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !agentId}>
          {saveMutation.isPending ? 'Saving...' : 'save'}
        </Button>
        {agentConfig && (
          <Button
            variant="outline"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
          >
            reset to project defaults
          </Button>
        )}
      </div>
    </div>
  )
}
