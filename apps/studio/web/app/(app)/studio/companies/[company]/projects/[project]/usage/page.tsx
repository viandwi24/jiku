'use client'

import { use, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ProjectUsageLog } from '@/lib/api'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@jiku/ui'
import { BarChart2, RefreshCw, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildPricingMap, estimateCost, formatTokens } from '@/lib/usage'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function formatDate(d: string): string {
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function RawDataDialog({ log }: { log: ProjectUsageLog }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        Raw
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono">
              Raw Data — {log.agent?.name ?? log.agent_id.slice(0, 8)} / {log.id.slice(0, 8)}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto space-y-4 text-xs font-mono">
            <div>
              <p className="text-muted-foreground mb-1">System Prompt</p>
              <pre className="bg-muted rounded p-3 whitespace-pre-wrap break-words">
                {log.raw_system_prompt ?? '(not captured)'}
              </pre>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Messages</p>
              <pre className="bg-muted rounded p-3 whitespace-pre-wrap break-words">
                {log.raw_messages ? JSON.stringify(log.raw_messages, null, 2) : '(not captured)'}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default function ProjectUsagePage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const [page, setPage] = useState(0)
  const pageSize = 100

  // Filters
  const [filterAgent, setFilterAgent] = useState<string>('all')
  const [filterMode, setFilterMode] = useState<string>('all')
  const [filterUser, setFilterUser] = useState<string>('all')
  const [search, setSearch] = useState('')

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })
  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: (d) => d.projects.find(p => p.slug === projectSlug) ?? null,
  })
  const projectId = projectsData?.id

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['project-usage', projectId, page],
    queryFn: () => api.projects.usage(projectId!, { limit: pageSize, offset: page * pageSize }),
    enabled: !!projectId,
    refetchInterval: 5000,
  })

  const { data: adaptersData } = useQuery({
    queryKey: ['adapters', 'provider-model'],
    queryFn: () => api.credentials.adapters('provider-model'),
    staleTime: 60_000,
  })
  const pricingMap = useMemo(() => buildPricingMap(adaptersData?.adapters ?? []), [adaptersData])

  const allLogs = data?.logs ?? []
  const summary = data?.summary
  const total = data?.total ?? 0

  // Derive filter options from data
  const agents = useMemo(() => {
    const map = new Map<string, string>()
    for (const log of allLogs) {
      if (log.agent) map.set(log.agent.id, log.agent.name)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [allLogs])

  const users = useMemo(() => {
    const map = new Map<string, string>()
    for (const log of allLogs) {
      if (log.user) map.set(log.user.id, log.user.name ?? log.user.email)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [allLogs])

  const modes = useMemo(() => {
    const set = new Set<string>()
    for (const log of allLogs) set.add(log.mode)
    return Array.from(set)
  }, [allLogs])

  // Apply client-side filters
  const filteredLogs = useMemo(() => {
    return allLogs.filter(log => {
      if (filterAgent !== 'all' && log.agent_id !== filterAgent) return false
      if (filterMode !== 'all' && log.mode !== filterMode) return false
      if (filterUser !== 'all' && log.user_id !== filterUser) return false
      if (search) {
        const q = search.toLowerCase()
        const agentMatch = log.agent?.name?.toLowerCase().includes(q)
        const userMatch = log.user?.name?.toLowerCase().includes(q) || log.user?.email?.toLowerCase().includes(q)
        const modeMatch = log.mode.toLowerCase().includes(q)
        if (!agentMatch && !userMatch && !modeMatch) return false
      }
      return true
    })
  }, [allLogs, filterAgent, filterMode, filterUser, search])

  // Filtered summary
  const filteredSummary = useMemo(() => ({
    total_runs: filteredLogs.length,
    total_input: filteredLogs.reduce((s, l) => s + l.input_tokens, 0),
    total_output: filteredLogs.reduce((s, l) => s + l.output_tokens, 0),
  }), [filteredLogs])

  const isFiltered = filterAgent !== 'all' || filterMode !== 'all' || filterUser !== 'all' || search !== ''
  const displaySummary = isFiltered ? filteredSummary : summary

  function resetFilters() {
    setFilterAgent('all')
    setFilterMode('all')
    setFilterUser('all')
    setSearch('')
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            Usage Monitor
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Token usage across all agents in this project.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      {displaySummary && (
        <div className="grid grid-cols-3 gap-3">
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Total Runs {isFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{displaySummary.total_runs.toLocaleString()}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Token In ←model {isFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{formatTokens(displaySummary.total_output)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Token Out →model {isFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{formatTokens(displaySummary.total_input)}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-xs w-48"
            placeholder="Search agent, user..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <Select value={filterAgent} onValueChange={setFilterAgent}>
          <SelectTrigger className="h-8 text-xs w-36">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterMode} onValueChange={setFilterMode}>
          <SelectTrigger className="h-8 text-xs w-32">
            <SelectValue placeholder="All modes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modes</SelectItem>
            {modes.map(m => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterUser} onValueChange={setFilterUser}>
          <SelectTrigger className="h-8 text-xs w-36">
            <SelectValue placeholder="All users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            {users.map(u => (
              <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isFiltered && (
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={resetFilters}>
            <X className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Agent</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">User</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Mode</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">In (←model)</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Out (→model)</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Est. Cost</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!isLoading && filteredLogs.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {isFiltered ? 'No results match the current filters.' : 'No usage logs yet. Start a chat to see data here.'}
                </td>
              </tr>
            )}
            {filteredLogs.map(log => (
              <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(log.created_at)}
                </td>
                <td className="px-3 py-2 text-xs font-medium">
                  {log.agent?.name ?? <span className="text-muted-foreground font-normal">{log.agent_id.slice(0, 8)}</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {log.user?.name ?? log.user?.email ?? (
                    <span className="text-muted-foreground">system</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className="text-xs h-5">
                    {log.mode}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
                  {log.model_id ?? '—'}
                </td>
                <td className="px-3 py-2 text-xs text-right font-mono">
                  {formatTokens(log.output_tokens)}
                </td>
                <td className="px-3 py-2 text-xs text-right font-mono">
                  {formatTokens(log.input_tokens)}
                </td>
                <td className="px-3 py-2 text-xs text-right text-muted-foreground font-mono">
                  {estimateCost(log.input_tokens, log.output_tokens, log.model_id, pricingMap)}
                </td>
                <td className="px-3 py-2">
                  <RawDataDialog log={log} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing page {page + 1} of {totalPages}
            {isFiltered && ` — ${filteredLogs.length} of ${allLogs.length} filtered`}
          </span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
