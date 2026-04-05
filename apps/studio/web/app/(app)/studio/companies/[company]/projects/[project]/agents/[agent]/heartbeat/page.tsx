'use client'

import { use, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Badge,
  Button,
  Input,
  Label,
  Switch,
  Textarea,
} from '@jiku/ui'
import { toast } from 'sonner'
import { Activity, Play } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

function formatRelative(d: string | null): string {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} hr ago`
  return `${Math.floor(diff / 86400000)} day(s) ago`
}

function formatNext(d: string | null): string {
  if (!d) return '—'
  const diff = new Date(d).getTime() - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < 60000) return 'in <1 min'
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)} min`
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)} hr`
  return `in ${Math.floor(diff / 86400000)} day(s)`
}

export default function HeartbeatPage({ params }: PageProps) {
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

  const { data: hbData, isLoading } = useQuery({
    queryKey: ['heartbeat', agentId],
    queryFn: () => api.heartbeat.get(agentId!),
    enabled: !!agentId,
  })

  const [enabled, setEnabled] = useState(false)
  const [cron, setCron] = useState('0 * * * *')
  const [prompt, setPrompt] = useState('')
  const [useCustomPrompt, setUseCustomPrompt] = useState(false)

  useEffect(() => {
    if (!hbData) return
    setEnabled(hbData.heartbeat_enabled)
    setCron(hbData.heartbeat_cron ?? '0 * * * *')
    const hasCustom = !!hbData.heartbeat_prompt
    setUseCustomPrompt(hasCustom)
    setPrompt(hbData.heartbeat_prompt ?? '')
  }, [hbData])

  const saveMutation = useMutation({
    mutationFn: () => api.heartbeat.update(agentId!, {
      heartbeat_enabled: enabled,
      heartbeat_cron: cron || null,
      heartbeat_prompt: useCustomPrompt && prompt.trim() ? prompt.trim() : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['heartbeat', agentId] })
      toast.success('Heartbeat settings saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  const triggerMutation = useMutation({
    mutationFn: () => api.heartbeat.trigger(agentId!),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['heartbeat', agentId] })
      toast.success(`Heartbeat triggered — run ID: ${d.conversation_id.slice(0, 8)}...`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Trigger failed'),
  })

  if (isLoading || !agentId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-lg">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Heartbeat
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Schedule autonomous runs for this agent. Heartbeats let the agent check in periodically and spawn tasks.
        </p>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between border rounded-lg p-4">
        <div>
          <p className="text-sm font-medium">Enable Heartbeat</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Agent will run on the configured schedule
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Schedule */}
      <div className="space-y-2">
        <Label className="text-xs font-medium">Schedule (cron expression)</Label>
        <Input
          value={cron}
          onChange={e => setCron(e.target.value)}
          placeholder="0 * * * *"
          className="font-mono text-sm"
          disabled={!enabled}
        />
        <p className="text-xs text-muted-foreground">
          5-field cron: minute hour day month weekday. E.g. <code className="font-mono">0 * * * *</code> = every hour.
        </p>

        {hbData && (
          <div className="flex gap-4 text-xs text-muted-foreground pt-1">
            <span>Last run: <strong>{formatRelative(hbData.heartbeat_last_run_at)}</strong></span>
            <span>Next run: <strong>{enabled ? formatNext(hbData.heartbeat_next_run_at) : '—'}</strong></span>
          </div>
        )}
      </div>

      {/* Prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Heartbeat Prompt</Label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Custom</span>
            <Switch
              checked={useCustomPrompt}
              onCheckedChange={setUseCustomPrompt}
              disabled={!enabled}
            />
          </div>
        </div>
        {useCustomPrompt ? (
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Enter a custom heartbeat prompt..."
            className="text-sm min-h-[120px] font-mono"
            disabled={!enabled}
          />
        ) : (
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground font-mono leading-relaxed">
            You are running in heartbeat mode — a scheduled autonomous check-in.
            Review pending items, spawn tasks as needed, and be proactive but focused.
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => triggerMutation.mutate()}
          disabled={triggerMutation.isPending || !agentId}
        >
          <Play className="h-3.5 w-3.5 mr-1" />
          {triggerMutation.isPending ? 'Triggering...' : 'Trigger Now'}
        </Button>
      </div>
    </div>
  )
}
