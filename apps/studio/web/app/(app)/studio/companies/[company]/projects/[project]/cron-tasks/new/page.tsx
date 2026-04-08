'use client'

import { use, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@jiku/ui'
import { ArrowLeft, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { CronExpressionInput } from '@/components/cron/cron-expression-input'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function NewCronTaskPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const router = useRouter()

  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
  })
  const company = companiesData?.companies.find(c => c.slug === companySlug)

  const { data: projectsData } = useQuery({
    queryKey: ['projects', company?.id],
    queryFn: () => api.projects.list(company!.id),
    enabled: !!company?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)
  const projectId = project?.id ?? ''

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api.agents.list(projectId),
    enabled: !!projectId,
  })

  // Only agents with task mode enabled and cron_task_enabled
  const eligibleAgents = (agentsData?.agents ?? []).filter(a =>
    a.allowed_modes.includes('task') && (a.cron_task_enabled !== false)
  )

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState('')
  const [cronExpression, setCronExpression] = useState('0 * * * *')
  const [prompt, setPrompt] = useState('')
  const [enabled, setEnabled] = useState(true)

  const createMutation = useMutation({
    mutationFn: () => api.cronTasks.create(projectId, {
      agent_id: agentId,
      name: name.trim(),
      description: description.trim() || undefined,
      cron_expression: cronExpression.trim(),
      prompt: prompt.trim(),
      enabled,
    }),
    onSuccess: () => {
      toast.success('Cron task created')
      router.push(`/studio/companies/${companySlug}/projects/${projectSlug}/cron-tasks`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create'),
  })

  const canSubmit = name.trim() && agentId && cronExpression.trim() && prompt.trim()

  return (
    <div className="p-6 space-y-6 max-w-lg">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-3 -ml-1 text-muted-foreground"
          onClick={() => router.back()}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h1 className="text-base font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4" />
          New Cron Task
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Schedule an agent to run automatically on a cron expression.
        </p>
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Name <span className="text-destructive">*</span></Label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Daily report"
          className="text-sm"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Description</Label>
        <Input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Optional description"
          className="text-sm"
        />
      </div>

      {/* Agent */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Agent <span className="text-destructive">*</span></Label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="text-sm">
            <SelectValue placeholder="Select an agent..." />
          </SelectTrigger>
          <SelectContent>
            {eligibleAgents.map(a => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
            {eligibleAgents.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No agents with task mode enabled
              </div>
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Only agents with task mode enabled are shown.</p>
      </div>

      {/* Cron Expression */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Cron Expression <span className="text-destructive">*</span></Label>
        <CronExpressionInput value={cronExpression} onChange={setCronExpression} />
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Prompt <span className="text-destructive">*</span></Label>
        <Textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Enter the prompt to send to the agent when this task runs..."
          className="text-sm min-h-30"
        />
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center justify-between border rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">Enable immediately</p>
          <p className="text-xs text-muted-foreground mt-0.5">Task will start scheduling right after creation</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || createMutation.isPending || !projectId}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? 'Creating...' : 'Create Cron Task'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
