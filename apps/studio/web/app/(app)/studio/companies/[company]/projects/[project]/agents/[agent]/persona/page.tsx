'use client'

import { use, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type PersonaSeed, type PersonaTraits } from '@/lib/api'
import { Button, Input, Label, Separator, Textarea, cn } from '@jiku/ui'
import { Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

const DEFAULT_TRAITS: PersonaTraits = {
  formality: 'balanced',
  verbosity: 'moderate',
  humor: 'light',
  empathy: 'moderate',
  expertise_display: 'balanced',
}

const TRAIT_OPTIONS: Record<keyof PersonaTraits, { label: string; options: string[] }> = {
  formality: { label: 'Formality', options: ['casual', 'balanced', 'formal'] },
  verbosity: { label: 'Verbosity', options: ['concise', 'moderate', 'detailed'] },
  humor: { label: 'Humor', options: ['none', 'light', 'frequent'] },
  empathy: { label: 'Empathy', options: ['low', 'moderate', 'high'] },
  expertise_display: { label: 'Expertise Display', options: ['simplified', 'balanced', 'technical'] },
}

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function PersonaPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })
  const { data: projectData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: (d) => d.projects.find(p => p.slug === projectSlug) ?? null,
  })
  const { data: agentData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id,
    select: (d) => d.agents.find(a => a.slug === agentSlug) ?? null,
  })
  const agentId = agentData?.id

  const { data, isLoading } = useQuery({
    queryKey: ['persona-prompt', agentId],
    queryFn: () => api.persona.getPrompt(agentId!),
    enabled: !!agentId,
  })

  const [value, setValue] = useState('')
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (!initialized && data !== undefined) {
      setValue(data.prompt ?? '')
      setInitialized(true)
    }
  }, [data, initialized])

  const saveMutation = useMutation({
    mutationFn: () => api.persona.updatePrompt(agentId!, value.trim() || null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persona-prompt', agentId] })
      toast.success('Persona saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const isDirty = (data?.prompt ?? '') !== value

  if (!agentId || isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold">Persona</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Write a persona prompt that gets injected directly into the system prompt before every run. Leave empty to disable.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Persona prompt</Label>
        <Textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={`You are Aria, a helpful research assistant.\nYou are concise, direct, and always cite your sources.`}
          className="text-sm resize-none font-mono"
          rows={12}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !isDirty}
        >
          Save
        </Button>
        {isDirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
      </div>

      <Separator />

      {/* Structured Traits (Plan 15.9) */}
      <TraitsAndBoundaries agentId={agentId} />
    </div>
  )
}

function TraitsAndBoundaries({ agentId }: { agentId: string }) {
  const qc = useQueryClient()

  const { data: seedData } = useQuery({
    queryKey: ['persona-seed', agentId],
    queryFn: () => api.persona.getSeed(agentId),
  })

  const seed = seedData?.seed ?? null
  const [traits, setTraits] = useState<PersonaTraits>(DEFAULT_TRAITS)
  const [boundaries, setBoundaries] = useState<string[]>([])
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (seed) {
      setTraits(seed.traits ?? DEFAULT_TRAITS)
      setBoundaries(seed.boundaries ?? [])
      setInitialized(true)
    } else if (seedData !== undefined) {
      setInitialized(true)
    }
  }, [seedData])

  const saveMutation = useMutation({
    mutationFn: () => api.persona.updateSeed(agentId, {
      ...(seed ?? {}),
      traits,
      boundaries: boundaries.filter(b => b.trim()),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persona-seed', agentId] })
      toast.success('Traits & boundaries saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const traitsChanged = initialized && JSON.stringify(traits) !== JSON.stringify(seed?.traits ?? DEFAULT_TRAITS)
  const boundariesChanged = initialized && JSON.stringify(boundaries.filter(b => b.trim())) !== JSON.stringify(seed?.boundaries ?? [])
  const isDirty = traitsChanged || boundariesChanged

  function updateTrait(key: keyof PersonaTraits, value: string) {
    setTraits({ ...traits, [key]: value as PersonaTraits[typeof key] })
  }

  return (
    <>
      {/* Traits */}
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Communication Traits</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Structured personality settings injected into the system prompt.
          </p>
        </div>

        <div className="space-y-3">
          {(Object.entries(TRAIT_OPTIONS) as [keyof PersonaTraits, typeof TRAIT_OPTIONS[keyof PersonaTraits]][]).map(([key, cfg]) => (
            <div key={key} className="space-y-1.5">
              <Label className="text-xs">{cfg.label}</Label>
              <div className="flex gap-1">
                {cfg.options.map(opt => (
                  <button
                    key={opt}
                    onClick={() => updateTrait(key, opt)}
                    className={cn(
                      'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                      traits[key] === opt
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80',
                    )}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      {/* Boundaries */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4" />
              Boundaries
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Hard rules the agent must never break, regardless of user requests.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setBoundaries([...boundaries, ''])}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>

        {boundaries.length === 0 ? (
          <div className="border border-dashed rounded-lg py-6 text-center text-sm text-muted-foreground">
            No boundaries set. The agent has no hard restrictions.
          </div>
        ) : (
          <div className="space-y-2">
            {boundaries.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={b}
                  onChange={e => setBoundaries(boundaries.map((x, j) => j === i ? e.target.value : x))}
                  placeholder="e.g. Never give medical or financial advice"
                  className="text-sm"
                />
                <button
                  onClick={() => setBoundaries(boundaries.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-destructive transition-colors p-1 shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {isDirty && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save Traits & Boundaries'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setTraits(seed?.traits ?? DEFAULT_TRAITS)
              setBoundaries(seed?.boundaries ?? [])
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </>
  )
}
