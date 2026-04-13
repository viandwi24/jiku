'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { CronTask } from '@/lib/api'
import {
  Badge,
  Button,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@jiku/ui'
import { Archive, ArchiveRestore, Clock, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
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

function formatSchedule(task: CronTask): string {
  if (task.mode === 'once') {
    return task.run_at ? new Date(task.run_at).toLocaleString() : '—'
  }
  return task.cron_expression ?? '—'
}

type TabKey = 'active' | 'archived'

export default function CronTasksPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const router = useRouter()
  const qc = useQueryClient()
  const [tab, setTab] = useState<TabKey>('active')

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

  const { data: cronData, isLoading } = useQuery({
    queryKey: ['cron-tasks', projectId, tab],
    queryFn: () => api.cronTasks.list(projectId, { status: tab }),
    enabled: !!projectId,
  })

  const [busyId, setBusyId] = useState<string | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cron-tasks', projectId, 'active'] })
    qc.invalidateQueries({ queryKey: ['cron-tasks', projectId, 'archived'] })
  }

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.cronTasks.update(projectId, id, { enabled }),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.cronTasks.delete(projectId, id),
    onSuccess: () => {
      invalidate()
      toast.success('Cron task deleted')
      setBusyId(null)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
      setBusyId(null)
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => api.cronTasks.archive(projectId, id),
    onSuccess: () => {
      invalidate()
      toast.success('Cron task archived')
      setBusyId(null)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to archive')
      setBusyId(null)
    },
  })

  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.cronTasks.restore(projectId, id),
    onSuccess: () => {
      invalidate()
      toast.success('Cron task restored')
      setBusyId(null)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to restore')
      setBusyId(null)
    },
  })

  const triggerMutation = useMutation({
    mutationFn: (id: string) => api.cronTasks.trigger(projectId, id),
    onSuccess: (d) => {
      toast.success(`Triggered — run ID: ${d.conversation_id.slice(0, 8)}...`)
      setBusyId(null)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Trigger failed')
      setBusyId(null)
    },
  })

  const handleDelete = (task: CronTask) => {
    if (!confirm(`Delete cron task "${task.name}"? This action cannot be undone.`)) return
    setBusyId(task.id)
    deleteMutation.mutate(task.id)
  }

  const handleArchive = (task: CronTask) => {
    setBusyId(task.id)
    archiveMutation.mutate(task.id)
  }

  const handleRestore = (task: CronTask) => {
    setBusyId(task.id)
    restoreMutation.mutate(task.id)
  }

  const handleTrigger = (task: CronTask) => {
    setBusyId(task.id)
    triggerMutation.mutate(task.id)
  }

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/cron-tasks`
  const tasks = cronData?.cron_tasks ?? []
  const isArchivedTab = tab === 'archived'

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Cron Tasks
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Scheduled tasks that run agents on a cron schedule or a one-shot time.
          </p>
        </div>
        <Button size="sm" onClick={() => router.push(`${base}/new`)}>
          <Plus className="h-4 w-4 mr-1" />
          New Cron Task
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-4">
          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )}

          {!isLoading && tasks.length === 0 && (
            <div className="border rounded-lg p-10 text-center">
              <Clock className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium">
                {isArchivedTab ? 'No archived tasks' : 'No cron tasks yet'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {isArchivedTab
                  ? 'One-shot tasks that have fired and manually archived tasks appear here.'
                  : 'Create your first scheduled task to get started.'}
              </p>
              {!isArchivedTab && (
                <Button size="sm" className="mt-4" onClick={() => router.push(`${base}/new`)}>
                  <Plus className="h-4 w-4 mr-1" />
                  New Cron Task
                </Button>
              )}
            </div>
          )}

          {!isLoading && tasks.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Schedule / Run At</TableHead>
                    <TableHead>Last Run</TableHead>
                    <TableHead>Next Run</TableHead>
                    <TableHead className="text-right">Runs</TableHead>
                    {!isArchivedTab && <TableHead>Enabled</TableHead>}
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map(task => (
                    <TableRow key={task.id} className="cursor-pointer hover:bg-muted/30" onClick={() => router.push(`${base}/${task.id}`)}>
                      <TableCell className="font-medium">
                        <div>
                          <p className="text-sm">{task.name}</p>
                          {task.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-[200px]">{task.description}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs font-mono">
                          {task.agent?.name ?? task.agent_id.slice(0, 8)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={task.mode === 'once' ? 'secondary' : 'outline'} className="text-xs">
                          {task.mode === 'once' ? 'Once' : 'Recurring'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{formatSchedule(task)}</code>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatRelative(task.last_run_at)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatNext(task.next_run_at, task.enabled, task.status)}</TableCell>
                      <TableCell className="text-right text-sm">{task.run_count}</TableCell>
                      {!isArchivedTab && (
                        <TableCell onClick={e => e.stopPropagation()}>
                          <Switch
                            checked={task.enabled}
                            onCheckedChange={(enabled) => toggleMutation.mutate({ id: task.id, enabled })}
                            disabled={toggleMutation.isPending}
                          />
                        </TableCell>
                      )}
                      <TableCell onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1 justify-end">
                          {!isArchivedTab && (
                            <>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                title="Trigger now"
                                disabled={busyId === task.id}
                                onClick={() => handleTrigger(task)}
                              >
                                <Play className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                title="Archive"
                                disabled={busyId === task.id}
                                onClick={() => handleArchive(task)}
                              >
                                <Archive className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                          {isArchivedTab && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Restore"
                              disabled={busyId === task.id}
                              onClick={() => handleRestore(task)}
                            >
                              <ArchiveRestore className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title="Delete permanently"
                            disabled={busyId === task.id}
                            onClick={() => handleDelete(task)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
