'use client'

import { use, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
import { ArrowLeft, Clock, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CronExpressionInput } from '@/components/cron/cron-expression-input'

interface PageProps {
  params: Promise<{ company: string; project: string; id: string }>
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

function formatRelative(d: string | null): string {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function formatNext(d: string | null, enabled: boolean): string {
  if (!enabled) return '—'
  if (!d) return '—'
  const diff = new Date(d).getTime() - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < 60000) return 'in <1m'
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`
  return `in ${Math.floor(diff / 86400000)}d`
}

export default function CronTaskDetailPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, id: taskId } = use(params)
  const router = useRouter()
  const qc = useQueryClient()

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

  const { data: taskData, isLoading } = useQuery({
    queryKey: ['cron-task', projectId, taskId],
    queryFn: () => api.cronTasks.get(projectId, taskId),
    enabled: !!projectId,
  })
  const task = taskData?.cron_task

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api.agents.list(projectId),
    enabled: !!projectId,
  })
  const eligibleAgents = (agentsData?.agents ?? []).filter(a =>
    a.allowed_modes.includes('task') && (a.cron_task_enabled !== false)
  )

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState('')
  const [cronExpression, setCronExpression] = useState('')
  const [prompt, setPrompt] = useState('')
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (!task) return
    setName(task.name)
    setDescription(task.description ?? '')
    setAgentId(task.agent_id)
    setCronExpression(task.cron_expression)
    setPrompt(task.prompt)
    setEnabled(task.enabled)
  }, [task])

  const saveMutation = useMutation({
    mutationFn: () => api.cronTasks.update(projectId, taskId, {
      name: name.trim(),
      description: description.trim() || null,
      agent_id: agentId,
      cron_expression: cronExpression.trim(),
      prompt: prompt.trim(),
      enabled,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cron-task', projectId, taskId] })
      qc.invalidateQueries({ queryKey: ['cron-tasks', projectId] })
      toast.success('Cron task saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  const triggerMutation = useMutation({
    mutationFn: () => api.cronTasks.trigger(projectId, taskId),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['cron-task', projectId, taskId] })
      toast.success(`Triggered — run ID: ${d.conversation_id.slice(0, 8)}...`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Trigger failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.cronTasks.delete(projectId, taskId),
    onSuccess: () => {
      toast.success('Cron task deleted')
      router.push(`/studio/companies/${companySlug}/projects/${projectSlug}/cron-tasks`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  })

  const handleDelete = () => {
    if (!confirm(`Delete cron task "${task?.name}"? This cannot be undone.`)) return
    deleteMutation.mutate()
  }

  if (isLoading || !projectId) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  if (!task) {
    return <div className="p-6 text-sm text-muted-foreground">Cron task not found.</div>
  }

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
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-base font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4" />
              {task.name}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Edit cron task settings</p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending}
            >
              <Play className="h-3.5 w-3.5 mr-1" />
              {triggerMutation.isPending ? 'Triggering...' : 'Trigger Now'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="border rounded-lg p-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">Run Count</p>
          <p className="font-semibold mt-0.5">{task.run_count}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Last Run</p>
          <p className="font-semibold mt-0.5">{formatRelative(task.last_run_at)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Next Run</p>
          <p className="font-semibold mt-0.5">{formatNext(task.next_run_at, task.enabled)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Created</p>
          <p className="font-semibold mt-0.5">{formatDate(task.created_at)}</p>
        </div>
        {task.caller && (
          <div className="col-span-2">
            <p className="text-muted-foreground">Created By</p>
            <p className="font-semibold mt-0.5">{task.caller.name} ({task.caller.email})</p>
          </div>
        )}
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Name</Label>
        <Input value={name} onChange={e => setName(e.target.value)} className="text-sm" />
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
        <Label className="text-xs font-medium">Agent</Label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="text-sm">
            <SelectValue placeholder="Select an agent..." />
          </SelectTrigger>
          <SelectContent>
            {eligibleAgents.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Cron Expression */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Cron Expression</Label>
        <CronExpressionInput value={cronExpression} onChange={setCronExpression} />
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Prompt</Label>
        <Textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          className="text-sm min-h-[120px]"
        />
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center justify-between border rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">Enabled</p>
          <p className="text-xs text-muted-foreground mt-0.5">Task will run on the configured schedule</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
