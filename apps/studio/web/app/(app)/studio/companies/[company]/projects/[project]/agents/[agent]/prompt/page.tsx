'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Label, Textarea } from '@jiku/ui'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentPromptPage({ params }: PageProps) {
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

  const [basePrompt, setBasePrompt] = useState('')
  if (agent && basePrompt === '') {
    setBasePrompt(agent.base_prompt ?? '')
  }

  const mutation = useMutation({
    mutationFn: () => api.agents.update(agent!.id, { base_prompt: basePrompt }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents', project?.id] })
      toast.success('Prompt saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  if (!agent) {
    return <div className="p-6"><p className="text-sm text-muted-foreground">Loading...</p></div>
  }

  return (
    <div className="p-6 max-w-2xl">
      <form
        onSubmit={e => { e.preventDefault(); mutation.mutate() }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="prompt">system prompt</Label>
          <p className="text-xs text-muted-foreground">The base instructions given to the agent at the start of every conversation.</p>
          <Textarea
            id="prompt"
            value={basePrompt}
            onChange={e => setBasePrompt(e.target.value)}
            rows={16}
            placeholder="You are a helpful AI agent..."
            className="font-mono text-sm resize-y"
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : 'save'}
          </Button>
        </div>
      </form>
    </div>
  )
}
