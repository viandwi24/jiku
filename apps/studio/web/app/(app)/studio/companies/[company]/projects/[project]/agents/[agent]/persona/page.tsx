'use client'

import { use, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Label, Textarea } from '@jiku/ui'
import { toast } from 'sonner'

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
    </div>
  )
}
