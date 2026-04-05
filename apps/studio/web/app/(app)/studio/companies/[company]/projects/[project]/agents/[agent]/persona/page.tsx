'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { PersonaSeed, MemoryItem } from '@/lib/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Input,
  Label,
  Separator,
  Textarea,
} from '@jiku/ui'
import { toast } from 'sonner'
import { Clock, Plus, RefreshCw, Trash2, X } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function PersonaPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const qc = useQueryClient()

  // Resolve agent id
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

  // Persona seed
  const { data: personaData, isLoading: seedLoading } = useQuery({
    queryKey: ['persona-seed', agentId],
    queryFn: () => api.persona.getSeed(agentId!),
    enabled: !!agentId,
  })

  // Agent_self memories (live persona)
  const { data: memoriesData, isLoading: memoriesLoading } = useQuery({
    queryKey: ['persona-memories', agentId],
    queryFn: () => api.persona.getMemories(agentId!),
    enabled: !!agentId,
  })

  const seed = personaData?.seed ?? null
  const seededAt = personaData?.seeded_at ?? null
  const memories: MemoryItem[] = memoriesData?.memories ?? []

  // Local form state
  const [form, setForm] = useState<PersonaSeed>({})
  const [formInitialized, setFormInitialized] = useState(false)
  const [newMemory, setNewMemory] = useState('')

  // Initialize form when data loads
  if (!formInitialized && personaData !== undefined) {
    setForm(seed ?? {})
    setFormInitialized(true)
  }

  const updateSeedMutation = useMutation({
    mutationFn: (data: PersonaSeed | null) => api.persona.updateSeed(agentId!, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persona-seed', agentId] })
      toast.success('Persona seed saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const resetMutation = useMutation({
    mutationFn: () => api.persona.reset(agentId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persona-seed', agentId] })
      qc.invalidateQueries({ queryKey: ['persona-memories', agentId] })
      toast.success('Persona reset — will re-seed on next run')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to reset'),
  })

  const deleteMemoryMutation = useMutation({
    mutationFn: (id: string) => api.memory.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persona-memories', agentId] })
      toast.success('Memory removed')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  function addInitialMemory() {
    const m = newMemory.trim()
    if (!m) return
    setForm(f => ({ ...f, initial_memories: [...(f.initial_memories ?? []), m] }))
    setNewMemory('')
  }

  function removeInitialMemory(idx: number) {
    setForm(f => ({ ...f, initial_memories: (f.initial_memories ?? []).filter((_, i) => i !== idx) }))
  }

  function handleSave() {
    const payload: PersonaSeed = {}
    if (form.name?.trim()) payload.name = form.name.trim()
    if (form.role?.trim()) payload.role = form.role.trim()
    if (form.personality?.trim()) payload.personality = form.personality.trim()
    if (form.communication_style?.trim()) payload.communication_style = form.communication_style.trim()
    if (form.background?.trim()) payload.background = form.background.trim()
    if (form.initial_memories?.length) payload.initial_memories = form.initial_memories
    updateSeedMutation.mutate(Object.keys(payload).length ? payload : null)
  }

  if (!agentId || seedLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    )
  }

  return (
    <div className="p-6 space-y-8 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold">Persona</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Define the initial seed for this agent&apos;s identity. Once seeded, the agent manages its own persona via memory tools.
        </p>
      </div>

      {/* Initial Seed Form */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Initial Seed</h3>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={form.name ?? ''}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Aria"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Role</Label>
            <Input
              value={form.role ?? ''}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
              placeholder="Research Assistant"
              className="h-8 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Personality</Label>
          <Input
            value={form.personality ?? ''}
            onChange={e => setForm(f => ({ ...f, personality: e.target.value }))}
            placeholder="curious, direct, warm"
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Communication Style</Label>
          <Input
            value={form.communication_style ?? ''}
            onChange={e => setForm(f => ({ ...f, communication_style: e.target.value }))}
            placeholder="concise and data-backed"
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Background / Expertise</Label>
          <Textarea
            value={form.background ?? ''}
            onChange={e => setForm(f => ({ ...f, background: e.target.value }))}
            placeholder="DeFi protocols, on-chain analytics"
            className="text-sm resize-none"
            rows={2}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Initial Memories (seed)</Label>
          <div className="space-y-1.5">
            {(form.initial_memories ?? []).map((m, i) => (
              <div key={i} className="flex items-center gap-2 text-sm bg-muted/50 rounded-md px-3 py-1.5">
                <span className="flex-1 text-muted-foreground">{m}</span>
                <button
                  onClick={() => removeInitialMemory(i)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                value={newMemory}
                onChange={e => setNewMemory(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInitialMemory() } }}
                placeholder="Add initial memory…"
                className="h-8 text-sm"
              />
              <Button size="sm" variant="outline" onClick={addInitialMemory} className="h-8 px-2">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateSeedMutation.isPending}
          >
            Save Seed
          </Button>

          {seededAt && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Seeded {new Date(seededAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      <Separator />

      {/* Current Persona — live agent_self memories */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Current Persona</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Live — managed by the agent via memory tools</p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive">
                <RefreshCw className="h-3.5 w-3.5" />
                Reset to Seed
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset persona?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete all current persona memories and re-apply the seed on the next run. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => resetMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Reset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {memoriesLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : memories.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No persona memories yet. {seededAt ? 'The agent will manage its persona as it runs.' : 'Save a seed and start a conversation to initialize.'}
          </p>
        ) : (
          <div className="space-y-1.5">
            {memories.map(m => (
              <div key={m.id} className="flex items-start gap-2 group bg-muted/30 rounded-md px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{m.content}</p>
                  {m.section && (
                    <Badge variant="outline" className="mt-1 text-[10px] h-4 px-1.5">{m.section}</Badge>
                  )}
                </div>
                <button
                  onClick={() => deleteMemoryMutation.mutate(m.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity mt-0.5"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
