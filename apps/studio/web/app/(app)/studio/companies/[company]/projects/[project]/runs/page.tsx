'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { RunRow } from '@/lib/api'
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@jiku/ui'
import { Activity, ChevronLeft, ChevronRight, XCircle } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function TypeBadge({ type }: { type: string }) {
  if (type === 'task') return (
    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-500/40 bg-amber-500/5 font-mono text-[10px]">
      ⚡ task
    </Badge>
  )
  if (type === 'heartbeat') return (
    <Badge variant="outline" className="gap-1 text-purple-600 border-purple-500/40 bg-purple-500/5 font-mono text-[10px]">
      🔄 heartbeat
    </Badge>
  )
  return (
    <Badge variant="outline" className="gap-1 text-blue-600 border-blue-500/40 bg-blue-500/5 font-mono text-[10px]">
      💬 chat
    </Badge>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: 'text-green-600 border-green-500/40 bg-green-500/5',
    completed: 'text-muted-foreground border-border bg-muted/30',
    failed: 'text-destructive border-destructive/40 bg-destructive/5',
    cancelled: 'text-orange-600 border-orange-500/40 bg-orange-500/5',
    idle: 'text-muted-foreground border-border',
  }
  const cls = map[status] ?? map['idle']!
  return (
    <Badge variant="outline" className={`font-mono text-[10px] ${cls}`}>
      {status}
    </Badge>
  )
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m ${s}s`
}

function formatRelative(dateStr: string | null): string {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function RunsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const router = useRouter()
  const qc = useQueryClient()

  const [page, setPage] = useState(1)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

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

  const { data, isLoading } = useQuery({
    queryKey: ['runs', project?.id, page, typeFilter, statusFilter],
    queryFn: () => api.runs.list(project!.id, {
      page,
      per_page: 20,
      type: typeFilter !== 'all' ? typeFilter : undefined,
      run_status: statusFilter !== 'all' ? statusFilter : undefined,
    }),
    enabled: !!project?.id,
    refetchInterval: 5000,
  })

  const cancelMutation = useMutation({
    mutationFn: (convId: string) => api.runs.cancel(convId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs', project?.id] }),
  })

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`
  const runs = data?.data ?? []
  const totalPages = data?.total_pages ?? 1

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Run History
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            All conversations, tasks, and heartbeats for this project
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Select value={typeFilter} onValueChange={v => { setTypeFilter(v); setPage(1) }}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="chat">Chat</SelectItem>
            <SelectItem value="task">Task</SelectItem>
            <SelectItem value="heartbeat">Heartbeat</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1) }}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="idle">Idle</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-28">Type</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Title</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-40">Agent</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-28">Status</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-20">Duration</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-24">Started</th>
              <th className="px-4 py-2.5 w-20" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!isLoading && runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No runs found
                </td>
              </tr>
            )}
            {runs.map(run => (
              <RunRow
                key={run.id}
                run={run}
                base={base}
                onCancel={() => cancelMutation.mutate(run.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {page} of {totalPages} ({data?.total ?? 0} total)</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function RunRow({ run, base, onCancel }: { run: RunRow; base: string; onCancel: () => void }) {
  const goal = (run.metadata as { goal?: string }).goal
  const displayTitle = run.title?.trim() || goal?.trim() || null
  return (
    <tr
      className="hover:bg-muted/30 cursor-pointer transition-colors"
      onClick={() => window.location.href = `${base}/runs/${run.id}`}
    >
      <td className="px-4 py-3">
        <TypeBadge type={run.type} />
      </td>
      <td className="px-4 py-3 max-w-0">
        {displayTitle ? (
          <div className="text-xs font-medium truncate" title={displayTitle}>{displayTitle}</div>
        ) : (
          <div className="text-xs text-muted-foreground font-mono truncate">{run.id.slice(0, 8)}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-xs truncate" title={run.agent_name}>{run.agent_name}</div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={run.run_status} />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
        {formatDuration(run.duration_ms)}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {formatRelative(run.started_at ?? run.created_at)}
      </td>
      <td className="px-4 py-3 text-right">
        {(run.run_status === 'running' || run.run_status === 'idle') && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={(e) => { e.stopPropagation(); onCancel() }}
            title="Cancel"
          >
            <XCircle className="h-3.5 w-3.5" />
          </Button>
        )}
      </td>
    </tr>
  )
}
import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(RunsPage, 'runs:read')
