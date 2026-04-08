'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ResolvedMemoryConfig } from '@/lib/api'
import { Button, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider, Switch, cn } from '@jiku/ui'
import { toast } from 'sonner'

const EMBEDDING_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', models: [
    { id: 'text-embedding-3-small', name: 'text-embedding-3-small (1536d, cheapest)', dimensions: 1536 },
    { id: 'text-embedding-3-large', name: 'text-embedding-3-large (3072d)', dimensions: 3072 },
  ]},
  { id: 'openrouter', name: 'OpenRouter', models: [
    { id: 'openai/text-embedding-3-small', name: 'text-embedding-3-small (1536d)', dimensions: 1536 },
    { id: 'openai/text-embedding-3-large', name: 'text-embedding-3-large (3072d)', dimensions: 3072 },
  ]},
]

const SUB_TABS = [
  { id: 'policy', label: 'Policy' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'core', label: 'Core' },
  { id: 'semantic', label: 'Semantic Search' },
] as const

type SubTab = typeof SUB_TABS[number]['id']

interface MemoryConfigProps {
  projectId: string
}

function SliderField({ label, description, value, onChange, min, max, step, format }: {
  label: string; description?: string; value: number; onChange: (v: number) => void
  min: number; max: number; step: number; format?: (v: number) => string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        <span className="text-sm tabular-nums font-medium">{format ? format(value) : value}</span>
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <Slider value={[value]} onValueChange={([v]) => onChange(v ?? value)} min={min} max={max} step={step} className="w-full" />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  )
}

export function MemoryConfig({ projectId }: MemoryConfigProps) {
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<SubTab>('policy')

  const { data: configData, isLoading } = useQuery({
    queryKey: ['project-memory-config', projectId],
    queryFn: () => api.memoryConfig.getProject(projectId),
    enabled: !!projectId,
  })

  const [cfg, setCfg] = useState<ResolvedMemoryConfig | null>(null)

  // Sync local state from server data — re-syncs after save + refetch
  useEffect(() => {
    if (configData?.config) {
      setCfg(configData.config)
    }
  }, [configData])

  const saveMutation = useMutation({
    mutationFn: () => api.memoryConfig.updateProject(projectId, cfg!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-memory-config', projectId] })
      toast.success('Memory config saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  if (isLoading || !cfg) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  function patchCfg(updater: (prev: ResolvedMemoryConfig) => ResolvedMemoryConfig) {
    setCfg(prev => prev ? updater(prev) : prev)
  }

  const embeddingDefaults = { enabled: false, provider: '', model: '', credential_id: null as string | null, dimensions: 1536 }

  const semanticEnabled = cfg.embedding?.enabled ?? false

  return (
    <div className="flex flex-col h-full">
      {/* Methods overview */}
      <div className="px-6 pt-4 pb-3 border-b space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Retrieval Methods</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Jiku uses multiple methods to find relevant memories. Each method contributes a weighted score.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <MethodCard
            name="Keyword Matching"
            desc="Overlap kata antara input dan memory"
            active={cfg.relevance.weights.keyword > 0}
            weight={cfg.relevance.weights.keyword}
            onToggle={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, keyword: v ? 0.25 : 0 } } }))}
            onClick={() => setActiveTab('scoring')}
          />
          <MethodCard
            name="Semantic Search"
            desc="Kemiripan makna via vector embedding (Qdrant)"
            active={semanticEnabled && (cfg.relevance.weights.semantic ?? 0) > 0}
            weight={cfg.relevance.weights.semantic ?? 0}
            onToggle={v => {
              patchCfg(p => ({
                ...p,
                embedding: { ...(p.embedding ?? embeddingDefaults), enabled: v },
                relevance: { ...p.relevance, weights: { ...p.relevance.weights, semantic: v ? 0.35 : 0 } },
              }))
              if (v) setActiveTab('semantic')
            }}
            onClick={() => setActiveTab('semantic')}
          />
          <MethodCard
            name="Recency"
            desc="Memory yang baru diakses lebih relevan"
            active={cfg.relevance.weights.recency > 0}
            weight={cfg.relevance.weights.recency}
            onToggle={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, recency: v ? 0.25 : 0 } } }))}
            onClick={() => setActiveTab('scoring')}
          />
          <MethodCard
            name="Access Frequency"
            desc="Memory yang sering dipakai lebih relevan"
            active={cfg.relevance.weights.access > 0}
            weight={cfg.relevance.weights.access}
            onToggle={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, access: v ? 0.15 : 0 } } }))}
            onClick={() => setActiveTab('scoring')}
          />
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="px-6 pt-3 pb-2 flex gap-1 border-b">
        {SUB_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
              activeTab === tab.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="px-6 py-5 max-w-xl space-y-6 flex-1 overflow-auto">
        {activeTab === 'policy' && (
          <>
            <div>
              <h2 className="text-sm font-semibold">Default Policy</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Applied to all agents that don't override these settings.</p>
            </div>
            <div className="space-y-4">
              <ToggleRow label="Read project memory" desc="Agents can read runtime_global memories shared across all agents."
                checked={cfg.policy.read.runtime_global}
                onChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, read: { ...p.policy.read, runtime_global: v } } }))} />
              <ToggleRow label="Write project memory" desc="Agents can write to runtime_global memories visible to all agents."
                checked={cfg.policy.write.runtime_global}
                onChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, write: { ...p.policy.write, runtime_global: v } } }))} />
              <ToggleRow label="Write agent-global memory" desc="Agents can write memories visible to all users of the same agent."
                checked={cfg.policy.write.agent_global}
                onChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, write: { ...p.policy.write, agent_global: v } } }))} />
              <ToggleRow label="Cross-user read" desc="Agents can read agent_shared memories belonging to other users."
                checked={cfg.policy.read.cross_user}
                onChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, read: { ...p.policy.read, cross_user: v } } }))} />
            </div>
          </>
        )}

        {activeTab === 'scoring' && (
          <>
            <div>
              <h2 className="text-sm font-semibold">Relevance Scoring</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Controls how extended memories are scored and selected for injection.</p>
            </div>
            <div className="space-y-5">
              <SliderField label="Max extended memories" description="Maximum number of relevance-scored memories injected per run."
                value={cfg.relevance.max_extended} onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, max_extended: v } }))}
                min={1} max={20} step={1} />
              <SliderField label="Min score threshold" description="Memories scoring below this are not injected."
                value={cfg.relevance.min_score} onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, min_score: v } }))}
                min={0.01} max={0.5} step={0.01} format={v => v.toFixed(2)} />
              <SliderField label="Keyword weight" description="Weight for keyword overlap between memory and current input."
                value={cfg.relevance.weights.keyword} onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, keyword: v } } }))}
                min={0} max={1} step={0.05} format={v => v.toFixed(2)} />
              <SliderField label="Recency weight" description="Weight for how recently the memory was accessed."
                value={cfg.relevance.weights.recency} onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, recency: v } } }))}
                min={0} max={1} step={0.05} format={v => v.toFixed(2)} />
              <SliderField label="Access frequency weight" description="Weight for how frequently the memory has been accessed."
                value={cfg.relevance.weights.access} onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, access: v } } }))}
                min={0} max={1} step={0.05} format={v => v.toFixed(2)} />
              <SliderField label="Recency half-life (days)" description="Days until recency score decays to 50%."
                value={cfg.relevance.recency_half_life_days} onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, recency_half_life_days: v } }))}
                min={7} max={180} step={7} format={v => `${v}d`} />
            </div>
          </>
        )}

        {activeTab === 'core' && (
          <>
            <div>
              <h2 className="text-sm font-semibold">Core Memory</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Core memories are always injected into the system prompt.</p>
            </div>
            <div className="space-y-5">
              <SliderField label="Max chars" description="Hard character limit for core memory content."
                value={cfg.core.max_chars} onChange={v => patchCfg(p => ({ ...p, core: { ...p.core, max_chars: v } }))}
                min={500} max={8000} step={500} format={v => `${v.toLocaleString()} chars`} />
              <SliderField label="Token budget" description="Maximum tokens allocated to the entire memory section."
                value={cfg.core.token_budget} onChange={v => patchCfg(p => ({ ...p, core: { ...p.core, token_budget: v } }))}
                min={100} max={2000} step={100} format={v => `${v} tokens`} />
            </div>
          </>
        )}

        {activeTab === 'semantic' && (
          <>
            <div>
              <h2 className="text-sm font-semibold">Semantic Search</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use vector embeddings for meaning-based memory retrieval via Qdrant.
              </p>
            </div>

            <ToggleRow label="Enable Semantic Search" desc="When enabled, memories are embedded and scored by semantic similarity."
              checked={cfg.embedding?.enabled ?? false}
              onChange={v => patchCfg(p => ({ ...p, embedding: { ...(p.embedding ?? embeddingDefaults), enabled: v } }))} />

            {cfg.embedding?.enabled && (
              <div className="space-y-4 border rounded-lg p-4">
                {/* Provider */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Embedding Provider</Label>
                  <Select
                    value={cfg.embedding.provider || ''}
                    onValueChange={v => {
                      const providerModels = EMBEDDING_PROVIDERS.find(p => p.id === v)?.models ?? []
                      const firstModel = providerModels[0]
                      patchCfg(p => ({ ...p, embedding: {
                        ...(p.embedding ?? embeddingDefaults),
                        provider: v,
                        model: firstModel?.id ?? '',
                        dimensions: firstModel?.dimensions ?? 1536,
                      }}))
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select provider..." /></SelectTrigger>
                    <SelectContent>
                      {EMBEDDING_PROVIDERS.map(p => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Model */}
                {cfg.embedding.provider && (
                  <div className="space-y-1.5">
                    <Label className="text-sm font-medium">Embedding Model</Label>
                    <Select
                      value={cfg.embedding.model || ''}
                      onValueChange={v => {
                        const allModels = EMBEDDING_PROVIDERS.flatMap(p => p.models)
                        const model = allModels.find(m => m.id === v)
                        patchCfg(p => ({ ...p, embedding: {
                          ...(p.embedding ?? embeddingDefaults),
                          model: v,
                          dimensions: model?.dimensions ?? 1536,
                        }}))
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select model..." /></SelectTrigger>
                      <SelectContent>
                        {(EMBEDDING_PROVIDERS.find(p => p.id === cfg.embedding?.provider)?.models ?? []).map(m => (
                          <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Credential */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Credential</Label>
                  <p className="text-xs text-muted-foreground">Select the API credential for the embedding provider.</p>
                  <EmbeddingCredentialPicker
                    projectId={projectId}
                    adapterId={cfg.embedding.provider}
                    value={cfg.embedding.credential_id ?? null}
                    onChange={v => patchCfg(p => ({ ...p, embedding: {
                      ...(p.embedding ?? embeddingDefaults),
                      credential_id: v,
                    }}))}
                  />
                </div>

                {/* Semantic weight */}
                <SliderField label="Semantic weight" description="Weight for semantic similarity in memory scoring."
                  value={cfg.relevance.weights.semantic ?? 0.35}
                  onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, semantic: v } } }))}
                  min={0} max={1} step={0.05} format={v => v.toFixed(2)} />
              </div>
            )}
          </>
        )}
      </div>

      {/* Save — always visible at bottom */}
      <div className="px-6 py-3 border-t">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !projectId}>
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function MethodCard({ name, desc, active, weight, onToggle, onClick }: {
  name: string; desc: string; active: boolean; weight: number
  onToggle: (enabled: boolean) => void; onClick?: () => void
}) {
  return (
    <div
      className={cn(
        'text-left rounded-lg border p-3 transition-colors',
        active ? 'border-primary/40 bg-primary/5' : 'border-border/50 bg-muted/20',
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <button onClick={onClick} className="text-xs font-semibold hover:underline cursor-pointer">
          {name}
        </button>
        <div className="flex items-center gap-2">
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-medium',
            active ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground',
          )}>
            {active ? `${(weight * 100).toFixed(0)}%` : 'off'}
          </span>
          <Switch
            checked={active}
            onCheckedChange={onToggle}
            className="scale-75"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">{desc}</p>
    </div>
  )
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function EmbeddingCredentialPicker({ projectId, adapterId, value, onChange }: {
  projectId: string; adapterId: string; value: string | null; onChange: (credId: string | null) => void
}) {
  const { data } = useQuery({
    queryKey: ['credentials-available', projectId],
    queryFn: () => api.credentials.available(projectId),
    enabled: !!projectId,
  })

  const filtered = (data?.credentials ?? []).filter(c => c.adapter_id === adapterId)

  if (!adapterId) return null

  if (filtered.length === 0) {
    return (
      <p className="text-xs text-amber-600">
        No {adapterId} credential found. Add one in Company or Project Settings &rarr; Credentials.
      </p>
    )
  }

  return (
    <Select value={value ?? ''} onValueChange={v => onChange(v || null)}>
      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select credential..." /></SelectTrigger>
      <SelectContent>
        {filtered.map(c => (
          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
