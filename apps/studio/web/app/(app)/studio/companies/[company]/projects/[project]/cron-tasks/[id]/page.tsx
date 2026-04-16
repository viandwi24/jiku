'use client'

import { use, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { CronTaskMode } from '@/lib/api'
import {
  Badge,
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
  Tabs,
  TabsList,
  TabsTrigger,
} from '@jiku/ui'
import { Archive, ArchiveRestore, ArrowLeft, Clock, Play, Trash2 } from 'lucide-react'
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

function formatNext(d: string | null, enabled: boolean, status: string): string {
  if (status === 'archived') return '—'
  if (!enabled) return '—'
  if (!d) return '—'
  const diff = new Date(d).getTime() - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < 60000) return 'in <1m'
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`
  return `in ${Math.floor(diff / 86400000)}d`
}

function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Convert UTC ISO → local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">.
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** Mirrors the helper in the new-task page. Derives a human platform label
 *  (e.g. "Telegram") from a connector's `plugin_id`. */
function platformFromPluginId(pluginId: string): string {
  const mid = pluginId.split('.')[1] ?? pluginId
  return mid.charAt(0).toUpperCase() + mid.slice(1)
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
  const [mode, setMode] = useState<CronTaskMode>('recurring')
  const [cronExpression, setCronExpression] = useState('')
  const [runAtLocal, setRunAtLocal] = useState('')
  const [prompt, setPrompt] = useState('')
  const [enabled, setEnabled] = useState(true)

  // Delivery — hydrated from task.context.delivery.
  const [deliveryConnectorId, setDeliveryConnectorId] = useState('')
  const [deliveryTargetName, setDeliveryTargetName] = useState('')
  const [deliveryChatId, setDeliveryChatId] = useState('')
  const [deliveryThreadId, setDeliveryThreadId] = useState('')

  const { data: connectorsData } = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.connectors.list(projectId),
    enabled: !!projectId,
  })

  const { data: targetsData } = useQuery({
    queryKey: ['connector-targets', deliveryConnectorId],
    queryFn: () => api.connectors.targets.list(deliveryConnectorId),
    enabled: !!deliveryConnectorId,
  })

  useEffect(() => {
    if (!task) return
    setName(task.name)
    setDescription(task.description ?? '')
    setAgentId(task.agent_id)
    setMode(task.mode)
    setCronExpression(task.cron_expression ?? '')
    setRunAtLocal(toLocalInputValue(task.run_at))
    setPrompt(task.prompt)
    setEnabled(task.enabled)
    const d = task.context?.delivery
    setDeliveryConnectorId(d?.connector_id ?? '')
    setDeliveryTargetName(d?.target_name ?? '')
    setDeliveryChatId(d?.chat_id ?? '')
    setDeliveryThreadId(d?.thread_id ?? '')
  }, [task])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cron-task', projectId, taskId] })
    qc.invalidateQueries({ queryKey: ['cron-tasks', projectId, 'active'] })
    qc.invalidateQueries({ queryKey: ['cron-tasks', projectId, 'archived'] })
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      // Build delivery patch — `null` clears, object sets, missing field = untouched.
      // Matches the new-task page's shape: require at least one addressable field
      // (target_name or chat_id) before sending a non-null spec; otherwise clear.
      type DeliveryPayload = {
        connector_id?: string
        target_name?: string
        chat_id?: string
        thread_id?: string
        platform?: string
      }
      let delivery: DeliveryPayload | null = null
      if (deliveryConnectorId) {
        const connector = connectorsData?.connectors.find(c => c.id === deliveryConnectorId)
        const spec: DeliveryPayload = {
          connector_id: deliveryConnectorId,
          ...(connector ? { platform: platformFromPluginId(connector.plugin_id) } : {}),
        }
        if (deliveryTargetName) {
          spec.target_name = deliveryTargetName
        } else {
          const cid = deliveryChatId.trim()
          const tid = deliveryThreadId.trim()
          if (cid) spec.chat_id = cid
          if (tid) spec.thread_id = tid
        }
        if (spec.target_name || spec.chat_id) delivery = spec
      }
      return api.cronTasks.update(projectId, taskId, {
        name: name.trim(),
        description: description.trim() || null,
        agent_id: agentId,
        mode,
        cron_expression: mode === 'recurring' ? cronExpression.trim() : null,
        run_at: mode === 'once' ? fromLocalInput(runAtLocal) : null,
        prompt: prompt.trim(),
        enabled,
        delivery,
      })
    },
    onSuccess: () => {
      invalidate()
      toast.success('Cron task saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  const triggerMutation = useMutation({
    mutationFn: () => api.cronTasks.trigger(projectId, taskId),
    onSuccess: (d) => {
      invalidate()
      toast.success(`Triggered — run ID: ${d.conversation_id.slice(0, 8)}...`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Trigger failed'),
  })

  const archiveMutation = useMutation({
    mutationFn: () => api.cronTasks.archive(projectId, taskId),
    onSuccess: () => {
      invalidate()
      toast.success('Cron task archived')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Archive failed'),
  })

  const restoreMutation = useMutation({
    mutationFn: () => api.cronTasks.restore(projectId, taskId),
    onSuccess: () => {
      invalidate()
      toast.success('Cron task restored')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Restore failed'),
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

  const isArchived = task.status === 'archived'
  const scheduleValid = mode === 'recurring'
    ? !!cronExpression.trim()
    : !!runAtLocal && !!fromLocalInput(runAtLocal)
  const canSubmit = name.trim() && agentId && prompt.trim() && scheduleValid

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
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4" />
              {task.name}
              <Badge variant={task.mode === 'once' ? 'secondary' : 'outline'} className="text-xs ml-1">
                {task.mode === 'once' ? 'Once' : 'Recurring'}
              </Badge>
              {isArchived && (
                <Badge variant="outline" className="text-xs">Archived</Badge>
              )}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Edit cron task settings</p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            {!isArchived && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => triggerMutation.mutate()}
                disabled={triggerMutation.isPending}
              >
                <Play className="h-3.5 w-3.5 mr-1" />
                {triggerMutation.isPending ? 'Triggering...' : 'Trigger Now'}
              </Button>
            )}
            {isArchived ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => restoreMutation.mutate()}
                disabled={restoreMutation.isPending}
              >
                <ArchiveRestore className="h-3.5 w-3.5 mr-1" />
                Restore
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => archiveMutation.mutate()}
                disabled={archiveMutation.isPending}
              >
                <Archive className="h-3.5 w-3.5 mr-1" />
                Archive
              </Button>
            )}
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
          <p className="font-semibold mt-0.5">{formatNext(task.next_run_at, task.enabled, task.status)}</p>
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

      {/* Mode */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Mode</Label>
        <Tabs value={mode} onValueChange={(v) => setMode(v as CronTaskMode)}>
          <TabsList>
            <TabsTrigger value="recurring">Recurring</TabsTrigger>
            <TabsTrigger value="once">Once</TabsTrigger>
          </TabsList>
        </Tabs>
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

      {/* Schedule */}
      {mode === 'recurring' ? (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Cron Expression</Label>
          <CronExpressionInput value={cronExpression} onChange={setCronExpression} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Run At</Label>
          <Input
            type="datetime-local"
            value={runAtLocal}
            onChange={e => setRunAtLocal(e.target.value)}
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">Local timezone. Stored as UTC.</p>
        </div>
      )}

      {/* Prompt */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Prompt</Label>
        <Textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          className="text-sm min-h-30"
        />
      </div>

      {/* Delivery (optional) — mirrors new-task page */}
      <div className="space-y-3 border rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">Delivery channel (optional)</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Where the task should send user-facing output. Clearing returns the task to silent /
            internal mode (file writes, slash-commands that deliver themselves, conditional schedulers).
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Connector</Label>
          <Select
            value={deliveryConnectorId || 'none'}
            onValueChange={(v) => {
              setDeliveryConnectorId(v === 'none' ? '' : v)
              setDeliveryTargetName('')
              setDeliveryChatId('')
              setDeliveryThreadId('')
            }}
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — silent task</SelectItem>
              {(connectorsData?.connectors ?? []).map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {c.display_name} · {platformFromPluginId(c.plugin_id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {deliveryConnectorId && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Target</Label>
              <Select
                value={deliveryTargetName || '__raw__'}
                onValueChange={(v) => setDeliveryTargetName(v === '__raw__' ? '' : v)}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__raw__">None — enter raw chat_id below</SelectItem>
                  {(targetsData?.targets ?? []).map(t => (
                    <SelectItem key={t.id} value={t.name}>
                      {t.display_name || t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Named targets are auto-registered on first inbound from a channel / forum topic, or created manually under Channels → Targets.
              </p>
            </div>

            {!deliveryTargetName && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Chat ID</Label>
                  <Input
                    value={deliveryChatId}
                    onChange={e => setDeliveryChatId(e.target.value)}
                    placeholder="e.g. -1003647779020"
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Thread ID (forum topic)</Label>
                  <Input
                    value={deliveryThreadId}
                    onChange={e => setDeliveryThreadId(e.target.value)}
                    placeholder="Leave empty for main chat"
                    className="text-sm"
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center justify-between border rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">Enabled</p>
          <p className="text-xs text-muted-foreground mt-0.5">Task will run on the configured schedule</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={isArchived} />
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || saveMutation.isPending || isArchived}
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
