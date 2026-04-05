'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Input, Label, Textarea } from '@jiku/ui'
import { toast } from 'sonner'

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

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Sync form when agent loads
  if (agent && name === '' && description === '') {
    setName(agent.name)
    setDescription(agent.description ?? '')
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.agents.update(agent!.id, { name, description: description || null }),
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
    <div className="p-6 max-w-xl">
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

        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : 'save'}
          </Button>
        </div>
      </form>
    </div>
  )
}
