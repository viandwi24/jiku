'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ResolvedMemoryConfig } from '@/lib/api'
import { Button, Label, Separator, Slider, Switch } from '@jiku/ui'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function SliderField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string
  description?: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  format?: (v: number) => string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        <span className="text-sm tabular-nums font-medium">{format ? format(value) : value}</span>
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v ?? value)}
        min={min}
        max={max}
        step={step}
        className="w-full"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  )
}

export default function ProjectSettingsMemoryPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
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
  const projectId = project?.id ?? ''

  const { data: configData, isLoading } = useQuery({
    queryKey: ['project-memory-config', projectId],
    queryFn: () => api.memoryConfig.getProject(projectId),
    enabled: !!projectId,
  })

  // Local state
  const [cfg, setCfg] = useState<ResolvedMemoryConfig | null>(null)
  const [initialized, setInitialized] = useState(false)

  if (configData?.config && !initialized) {
    setCfg(configData.config)
    setInitialized(true)
  }

  const saveMutation = useMutation({
    mutationFn: () => api.memoryConfig.updateProject(projectId, cfg!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-memory-config', projectId] })
      setInitialized(false)
      toast.success('Memory config saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  if (isLoading || !cfg) {
    return <div className="text-sm text-muted-foreground py-4">Loading...</div>
  }

  function patchCfg(updater: (prev: ResolvedMemoryConfig) => ResolvedMemoryConfig) {
    setCfg(prev => prev ? updater(prev) : prev)
  }

  return (
    <div className="space-y-8">
      {/* Default Policy */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Default Policy</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Applied to all agents that don't override these settings.</p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Read project memory</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Agents can read runtime_global memories shared across all agents.</p>
            </div>
            <Switch
              checked={cfg.policy.read.runtime_global}
              onCheckedChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, read: { ...p.policy.read, runtime_global: v } } }))}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Write project memory</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Agents can write to runtime_global memories visible to all agents.</p>
            </div>
            <Switch
              checked={cfg.policy.write.runtime_global}
              onCheckedChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, write: { ...p.policy.write, runtime_global: v } } }))}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Write agent-global memory</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Agents can write memories visible to all users of the same agent.</p>
            </div>
            <Switch
              checked={cfg.policy.write.agent_global}
              onCheckedChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, write: { ...p.policy.write, agent_global: v } } }))}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Cross-user read</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Agents can read agent_shared memories belonging to other users.</p>
            </div>
            <Switch
              checked={cfg.policy.read.cross_user}
              onCheckedChange={v => patchCfg(p => ({ ...p, policy: { ...p.policy, read: { ...p.policy.read, cross_user: v } } }))}
            />
          </div>
        </div>
      </section>

      <Separator />

      {/* Relevance Scoring */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Relevance Scoring</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Controls how extended memories are scored and selected for injection.</p>
        </div>

        <div className="space-y-5">
          <SliderField
            label="Max extended memories"
            description="Maximum number of relevance-scored memories injected per run."
            value={cfg.relevance.max_extended}
            onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, max_extended: v } }))}
            min={1}
            max={20}
            step={1}
          />
          <SliderField
            label="Min score threshold"
            description="Memories scoring below this are not injected."
            value={cfg.relevance.min_score}
            onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, min_score: v } }))}
            min={0.01}
            max={0.5}
            step={0.01}
            format={v => v.toFixed(2)}
          />
          <SliderField
            label="Keyword weight"
            description="Weight for keyword overlap between memory and current input."
            value={cfg.relevance.weights.keyword}
            onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, keyword: v } } }))}
            min={0}
            max={1}
            step={0.05}
            format={v => v.toFixed(2)}
          />
          <SliderField
            label="Recency weight"
            description="Weight for how recently the memory was accessed."
            value={cfg.relevance.weights.recency}
            onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, recency: v } } }))}
            min={0}
            max={1}
            step={0.05}
            format={v => v.toFixed(2)}
          />
          <SliderField
            label="Access frequency weight"
            description="Weight for how frequently the memory has been accessed."
            value={cfg.relevance.weights.access}
            onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, weights: { ...p.relevance.weights, access: v } } }))}
            min={0}
            max={1}
            step={0.05}
            format={v => v.toFixed(2)}
          />
          <SliderField
            label="Recency half-life (days)"
            description="Days until recency score decays to 50%."
            value={cfg.relevance.recency_half_life_days}
            onChange={v => patchCfg(p => ({ ...p, relevance: { ...p.relevance, recency_half_life_days: v } }))}
            min={7}
            max={180}
            step={7}
            format={v => `${v}d`}
          />
        </div>
      </section>

      <Separator />

      {/* Core Memory */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Core Memory</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Core memories are always injected into the system prompt.</p>
        </div>

        <div className="space-y-5">
          <SliderField
            label="Max chars"
            description="Hard character limit for core memory content."
            value={cfg.core.max_chars}
            onChange={v => patchCfg(p => ({ ...p, core: { ...p.core, max_chars: v } }))}
            min={500}
            max={8000}
            step={500}
            format={v => `${v.toLocaleString()} chars`}
          />
          <SliderField
            label="Token budget"
            description="Maximum tokens allocated to the entire memory section."
            value={cfg.core.token_budget}
            onChange={v => patchCfg(p => ({ ...p, core: { ...p.core, token_budget: v } }))}
            min={100}
            max={2000}
            step={100}
            format={v => `${v} tokens`}
          />
        </div>
      </section>

      <Separator />

      {/* Extraction */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Extraction</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Automatically extract and store facts after each conversation turn.</p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Enabled</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Run a small LLM after each turn to extract memorable facts.</p>
            </div>
            <Switch
              checked={cfg.extraction.enabled}
              onCheckedChange={v => patchCfg(p => ({ ...p, extraction: { ...p.extraction, enabled: v } }))}
            />
          </div>

          {cfg.extraction.enabled && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Target scope</Label>
                <p className="text-xs text-muted-foreground">Which scope to extract facts into.</p>
                <div className="flex gap-2 mt-1">
                  {(['agent_caller', 'agent_global', 'both'] as const).map(opt => (
                    <button
                      key={opt}
                      onClick={() => patchCfg(p => ({ ...p, extraction: { ...p.extraction, target_scope: opt } }))}
                      className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                        cfg.extraction.target_scope === opt
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:text-foreground'
                      }`}
                    >
                      {opt === 'agent_caller' ? 'user-scoped' : opt === 'agent_global' ? 'agent-global' : 'both'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="pt-2">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !projectId}>
          {saveMutation.isPending ? 'Saving...' : 'save'}
        </Button>
      </div>
    </div>
  )
}
