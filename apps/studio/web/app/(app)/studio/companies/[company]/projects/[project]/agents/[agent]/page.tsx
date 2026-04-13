'use client'

import { use, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AgentAdapterInfo } from '@/lib/api'
import { Button, Checkbox, Input, Label, Textarea } from '@jiku/ui'
import { toast } from 'sonner'

const AVAILABLE_MODES = [
  { value: 'chat', label: 'Chat', description: 'Standard conversational mode' },
  { value: 'task', label: 'Task', description: 'Autonomous task execution (required for heartbeat)' },
] as const

const DEFAULT_ADAPTER_ID = 'jiku.agent.default'

type ModeConfig = { adapter: string; config?: Record<string, unknown> }
type ModeConfigs = Record<string, ModeConfig>

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentInfoPage({ params }: PageProps) {
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

  const adaptersQuery = useQuery({
    queryKey: ['agent-adapters'],
    queryFn: () => api.agents.listAdapters().then(r => r.adapters),
    staleTime: 60_000,
  })
  const adapters = adaptersQuery.data ?? []
  const adapterById = useMemo(() => {
    const m = new Map<string, AgentAdapterInfo>()
    for (const a of adapters) m.set(a.id, a)
    return m
  }, [adapters])

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [allowedModes, setAllowedModes] = useState<string[]>([])
  const [modeConfigs, setModeConfigs] = useState<ModeConfigs>({})
  const [initialized, setInitialized] = useState(false)

  // Sync form when agent loads
  if (agent && !initialized) {
    setName(agent.name)
    setDescription(agent.description ?? '')
    setAllowedModes(agent.allowed_modes ?? ['chat'])
    setModeConfigs((agent.mode_configs ?? {}) as ModeConfigs)
    setInitialized(true)
  }

  function toggleMode(mode: string) {
    setAllowedModes(prev =>
      prev.includes(mode) ? prev.filter(m => m !== mode) : [...prev, mode]
    )
  }

  function setAdapter(mode: string, adapterId: string) {
    setModeConfigs(prev => ({
      ...prev,
      [mode]: { adapter: adapterId, config: defaultConfigFor(adapterById.get(adapterId)) },
    }))
  }

  function setConfigValue(mode: string, key: string, value: unknown) {
    setModeConfigs(prev => {
      const cur = prev[mode] ?? { adapter: DEFAULT_ADAPTER_ID, config: {} }
      return {
        ...prev,
        [mode]: { ...cur, config: { ...(cur.config ?? {}), [key]: value } },
      }
    })
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.agents.update(agent!.id, {
        name,
        description: description || null,
        allowed_modes: allowedModes,
        mode_configs: buildSavedModeConfigs(modeConfigs, allowedModes),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents', project?.id] })
      toast.success('Agent updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  if (!agent) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl">
      <form
        onSubmit={e => { e.preventDefault(); mutation.mutate() }}
        className="space-y-5"
      >
        <div className="space-y-2">
          <Label htmlFor="name">name</Label>
          <Input
            id="name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={4}
            placeholder="What does this agent do?"
          />
        </div>

        <div className="space-y-3">
          <div>
            <Label>Modes & Adapters</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Pilih execution adapter dan config-nya per mode. Setiap adapter punya config sendiri
              (mis. <code>max_tool_calls</code> untuk Default Agent).
            </p>
          </div>
          <div className="space-y-3">
            {AVAILABLE_MODES.map(mode => {
              const enabled = allowedModes.includes(mode.value)
              const current = modeConfigs[mode.value]
              const selectedAdapterId = current?.adapter ?? DEFAULT_ADAPTER_ID
              const selectedAdapter = adapterById.get(selectedAdapterId)
              return (
                <div key={mode.value} className="rounded-md border p-3 space-y-3">
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id={`mode-${mode.value}`}
                      checked={enabled}
                      onCheckedChange={() => toggleMode(mode.value)}
                    />
                    <div className="grid gap-0.5 leading-none">
                      <label htmlFor={`mode-${mode.value}`} className="text-sm font-medium cursor-pointer">
                        {mode.label}
                      </label>
                      <p className="text-xs text-muted-foreground">{mode.description}</p>
                    </div>
                  </div>
                  {enabled && (
                    <div className="space-y-3 pl-7">
                      <div className="space-y-1">
                        <Label className="text-xs">Adapter</Label>
                        <select
                          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                          value={selectedAdapterId}
                          onChange={e => setAdapter(mode.value, e.target.value)}
                          disabled={adaptersQuery.isLoading}
                        >
                          {adapters.length === 0 && (
                            <option value={selectedAdapterId}>{selectedAdapterId}</option>
                          )}
                          {adapters.map(a => (
                            <option key={a.id} value={a.id}>{a.displayName}</option>
                          ))}
                        </select>
                        {selectedAdapter?.description && (
                          <p className="text-xs text-muted-foreground">{selectedAdapter.description}</p>
                        )}
                      </div>
                      {selectedAdapter && (
                        <AdapterConfigFields
                          adapter={selectedAdapter}
                          values={current?.config ?? {}}
                          onChange={(key, value) => setConfigValue(mode.value, key, value)}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending || allowedModes.length === 0}>
            {mutation.isPending ? 'Saving...' : 'save'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function AdapterConfigFields({
  adapter,
  values,
  onChange,
}: {
  adapter: AgentAdapterInfo
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}) {
  const properties = adapter.configSchema?.properties ?? {}
  const keys = Object.keys(properties)
  if (keys.length === 0) {
    return <p className="text-xs text-muted-foreground">Adapter ini tidak punya opsi konfigurasi.</p>
  }
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="text-xs font-medium text-muted-foreground">Adapter Config</p>
      {keys.map(key => {
        const prop = properties[key]!
        const raw = values[key]
        const current = raw !== undefined ? raw : (prop.default ?? '')
        if (prop.type === 'boolean') {
          return (
            <div key={key} className="flex items-center gap-2">
              <Checkbox
                id={`cfg-${adapter.id}-${key}`}
                checked={Boolean(current)}
                onCheckedChange={v => onChange(key, Boolean(v))}
              />
              <Label htmlFor={`cfg-${adapter.id}-${key}`} className="text-xs">
                {key}
              </Label>
              {prop.description && (
                <span className="text-xs text-muted-foreground">{prop.description}</span>
              )}
            </div>
          )
        }
        const isNumber = prop.type === 'number'
        return (
          <div key={key} className="space-y-1">
            <Label className="text-xs">{key}</Label>
            <Input
              type={isNumber ? 'number' : 'text'}
              value={String(current)}
              min={prop.minimum}
              max={prop.maximum}
              onChange={e => {
                const v = e.target.value
                if (isNumber) {
                  const n = v === '' ? undefined : Number(v)
                  onChange(key, Number.isNaN(n) ? undefined : n)
                } else {
                  onChange(key, v)
                }
              }}
            />
            {prop.description && (
              <p className="text-xs text-muted-foreground">{prop.description}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function defaultConfigFor(adapter: AgentAdapterInfo | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!adapter) return out
  for (const [key, prop] of Object.entries(adapter.configSchema?.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default
  }
  return out
}

function buildSavedModeConfigs(configs: ModeConfigs, allowedModes: string[]): ModeConfigs {
  const out: ModeConfigs = {}
  for (const mode of allowedModes) {
    const cur = configs[mode]
    if (cur?.adapter) out[mode] = cur
  }
  return out
}
