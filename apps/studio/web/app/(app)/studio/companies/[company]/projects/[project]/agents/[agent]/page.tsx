'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Checkbox, Input, Label, Textarea } from '@jiku/ui'
import { toast } from 'sonner'

const AVAILABLE_MODES = [
  { value: 'chat', label: 'Chat', description: 'Standard conversational mode' },
  { value: 'task', label: 'Task', description: 'Autonomous task execution (required for heartbeat)' },
] as const

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
  const [allowedModes, setAllowedModes] = useState<string[]>([])
  const [maxToolCalls, setMaxToolCalls] = useState(40)
  const [initialized, setInitialized] = useState(false)

  // Sync form when agent loads
  if (agent && !initialized) {
    setName(agent.name)
    setDescription(agent.description ?? '')
    setAllowedModes(agent.allowed_modes ?? ['chat'])
    setMaxToolCalls(agent.max_tool_calls ?? 40)
    setInitialized(true)
  }

  function toggleMode(mode: string) {
    setAllowedModes(prev =>
      prev.includes(mode) ? prev.filter(m => m !== mode) : [...prev, mode]
    )
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.agents.update(agent!.id, { name, description: description || null, allowed_modes: allowedModes, max_tool_calls: maxToolCalls }),
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

        <div className="space-y-2">
          <Label>Allowed Modes</Label>
          <div className="space-y-2 rounded-md border p-3">
            {AVAILABLE_MODES.map(mode => (
              <div key={mode.value} className="flex items-start gap-2.5">
                <Checkbox
                  id={`mode-${mode.value}`}
                  checked={allowedModes.includes(mode.value)}
                  onCheckedChange={() => toggleMode(mode.value)}
                />
                <div className="grid gap-0.5 leading-none">
                  <label htmlFor={`mode-${mode.value}`} className="text-sm font-medium cursor-pointer">
                    {mode.label}
                  </label>
                  <p className="text-xs text-muted-foreground">{mode.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="max-tool-calls">Max Tool Calls</Label>
          <Input
            id="max-tool-calls"
            type="number"
            min={1}
            max={200}
            value={maxToolCalls}
            onChange={e => setMaxToolCalls(Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">Maximum number of tool-call steps per run. Default: 40</p>
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
