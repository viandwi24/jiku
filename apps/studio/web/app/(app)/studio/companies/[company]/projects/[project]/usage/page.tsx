'use client'

import { use, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ProjectUsageLog } from '@/lib/api'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
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
import { BarChart2, RefreshCw, Search, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { aggregateByAgent, aggregateByDay, buildPricingMap, estimateCost, estimateTotalCost, formatTokens } from '@/lib/usage'
import { AgentUsageBarChart, TokenUsageAreaChart } from '@/components/usage/usage-charts'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

const PAGE_SIZE = 50

type DateRange = 'today' | 'week' | 'month' | 'year' | 'all'

function getSince(range: DateRange): string | undefined {
  if (range === 'all') return undefined
  const now = new Date()
  if (range === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  if (range === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - 7)
    return d.toISOString()
  }
  if (range === 'month') {
    const d = new Date(now)
    d.setMonth(d.getMonth() - 1)
    return d.toISOString()
  }
  if (range === 'year') {
    const d = new Date(now)
    d.setFullYear(d.getFullYear() - 1)
    return d.toISOString()
  }
}

/** Plan 19 — color-coded tint per usage source so the table scans visually. */
function sourceBadgeClass(src: string | null | undefined): string {
  if (!src) return ''
  if (src === 'chat' || src === 'task') return 'bg-blue-500/10 text-blue-600 border-blue-500/20'
  if (src === 'reflection') return 'bg-purple-500/10 text-purple-600 border-purple-500/20'
  if (src.startsWith('dreaming')) return 'bg-indigo-500/10 text-indigo-600 border-indigo-500/20'
  if (src === 'flush') return 'bg-slate-500/10 text-slate-600 border-slate-500/20'
  if (src === 'title') return 'bg-teal-500/10 text-teal-600 border-teal-500/20'
  if (src.startsWith('plugin:')) return 'bg-amber-500/10 text-amber-700 border-amber-500/20'
  return ''
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
        <DialogContent className="min-w-[45vw] max-w-[45vw] max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono">
              Raw Data — {log.agent?.name ?? log.agent_id?.slice(0, 8) ?? 'unknown'} / {log.id.slice(0, 8)}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto text-xs font-mono">
            <Accordion type="multiple" className="w-full">
              <AccordionItem value="system-prompt">
                <AccordionTrigger className="text-xs">
                  System Prompt
                  <span className="ml-auto mr-2 text-[10px] text-muted-foreground">
                    {log.raw_system_prompt ? `${log.raw_system_prompt.length} chars` : 'empty'}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="bg-muted rounded p-3 whitespace-pre-wrap wrap-break-word max-h-[50vh] overflow-auto">
                    {log.raw_system_prompt ?? '(not captured)'}
                  </pre>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="messages">
                <AccordionTrigger className="text-xs">
                  Messages
                  <span className="ml-auto mr-2 text-[10px] text-muted-foreground">
                    {Array.isArray(log.raw_messages) ? `${log.raw_messages.length} items` : log.raw_messages ? '1 item' : 'empty'}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="bg-muted rounded p-3 whitespace-pre-wrap wrap-break-word max-h-[50vh] overflow-auto">
                    {log.raw_messages ? JSON.stringify(log.raw_messages, null, 2) : '(not captured)'}
                  </pre>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="response">
                <AccordionTrigger className="text-xs">
                  Response
                  <span className="ml-auto mr-2 text-[10px] text-muted-foreground">
                    {log.raw_response ? `${log.raw_response.length} chars` : 'empty'}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="bg-muted rounded p-3 whitespace-pre-wrap wrap-break-word max-h-[50vh] overflow-auto">
                    {log.raw_response ?? '(not captured)'}
                  </pre>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="active-tools">
                <AccordionTrigger className="text-xs">
                  Active Tools
                  <span className="ml-auto mr-2 text-[10px] text-muted-foreground">
                    {Array.isArray(log.active_tools) ? `${log.active_tools.length} tools` : 'not captured'}
                    {log.agent_adapter ? ` · ${log.agent_adapter}` : ''}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="bg-muted rounded p-3 max-h-[50vh] overflow-auto">
                    {log.agent_adapter && (
                      <div className="mb-2 text-[11px] text-muted-foreground">
                        adapter: <code>{log.agent_adapter}</code>
                      </div>
                    )}
                    {Array.isArray(log.active_tools) && log.active_tools.length > 0 ? (
                      <ul className="list-disc pl-4 space-y-0.5">
                        {log.active_tools.map(t => (
                          <li key={t}><code>{t}</code></li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">(not captured)</p>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ProjectUsagePage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const [page, setPage] = useState(0)

  // Date range (server-side)
  const [dateRange, setDateRange] = useState<DateRange>('month')

  // Client-side filters
  const [filterAgent, setFilterAgent] = useState<string>('all')
  const [filterMode, setFilterMode] = useState<string>('all')
  const [filterSource, setFilterSource] = useState<string>('all')
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

  const since = getSince(dateRange)

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['project-usage', projectId, page, dateRange],
    queryFn: () => api.projects.usage(projectId!, { limit: PAGE_SIZE, offset: page * PAGE_SIZE, since }),
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
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // Derive filter options from loaded page
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

  const sources = useMemo(() => {
    const set = new Set<string>()
    for (const log of allLogs) if (log.source) set.add(log.source)
    return Array.from(set).sort()
  }, [allLogs])

  // Client-side filters on top of server-paginated data
  const filteredLogs = useMemo(() => {
    return allLogs.filter(log => {
      if (filterAgent !== 'all' && log.agent_id !== filterAgent) return false
      if (filterMode !== 'all' && log.mode !== filterMode) return false
      if (filterSource !== 'all' && log.source !== filterSource) return false
      if (filterUser !== 'all' && log.user_id !== filterUser) return false
      if (search) {
        const q = search.toLowerCase()
        const agentMatch = log.agent?.name?.toLowerCase().includes(q)
        const userMatch = log.user?.name?.toLowerCase().includes(q) || log.user?.email?.toLowerCase().includes(q)
        const modeMatch = log.mode.toLowerCase().includes(q)
        const sourceMatch = log.source?.toLowerCase().includes(q)
        if (!agentMatch && !userMatch && !modeMatch && !sourceMatch) return false
      }
      return true
    })
  }, [allLogs, filterAgent, filterMode, filterSource, filterUser, search])

  const filteredSummary = useMemo(() => ({
    total_runs: filteredLogs.length,
    total_input: filteredLogs.reduce((s, l) => s + l.input_tokens, 0),
    total_output: filteredLogs.reduce((s, l) => s + l.output_tokens, 0),
  }), [filteredLogs])

  const isClientFiltered = filterAgent !== 'all' || filterMode !== 'all' || filterSource !== 'all' || filterUser !== 'all' || search !== ''
  const displaySummary = isClientFiltered ? filteredSummary : summary
  const activeLogs = isClientFiltered ? filteredLogs : allLogs
  const totalTokens = (displaySummary?.total_input ?? 0) + (displaySummary?.total_output ?? 0)
  const estimatedCost = useMemo(() => estimateTotalCost(activeLogs, pricingMap), [activeLogs, pricingMap])
  const dailyData = useMemo(() => aggregateByDay(activeLogs), [activeLogs])
  const agentData = useMemo(() => aggregateByAgent(activeLogs), [activeLogs])

  function resetClientFilters() {
    setFilterAgent('all')
    setFilterMode('all')
    setFilterSource('all')
    setFilterUser('all')
    setSearch('')
  }

  function handleDateRange(range: DateRange) {
    setDateRange(range)
    setPage(0) // reset to first page when date range changes
  }

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
        <div className="flex items-center gap-2">
          {/* Date range tabs */}
          <div className="flex items-center border rounded-md overflow-hidden text-xs">
            {(['today', 'week', 'month', 'year', 'all'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => handleDateRange(range)}
                className={cn(
                  'px-3 py-1.5 transition-colors',
                  dateRange === range
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted/50 text-muted-foreground',
                )}
              >
                {range === 'today' ? 'Today' : range === 'week' ? 'Last 7d' : range === 'month' ? 'Last 30d' : range === 'year' ? 'Last year' : 'All time'}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      {displaySummary && (
        <div className="grid grid-cols-5 gap-3">
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Total Runs {isClientFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{displaySummary.total_runs.toLocaleString()}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Token In ←model {isClientFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{formatTokens(displaySummary.total_output)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Token Out →model {isClientFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{formatTokens(displaySummary.total_input)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Total Tokens {isClientFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{formatTokens(totalTokens)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Estimated Cost {isClientFiltered && <span className="text-primary">(filtered)</span>}</p>
            <p className="text-2xl font-semibold">{estimatedCost}</p>
          </div>
        </div>
      )}

      {/* Charts */}
      {activeLogs.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <TokenUsageAreaChart data={dailyData} />
          <AgentUsageBarChart data={agentData} />
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

        <Select value={filterSource} onValueChange={setFilterSource}>
          <SelectTrigger className="h-8 text-xs w-40">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map(s => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
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

        {isClientFiltered && (
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={resetClientFilters}>
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
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Source</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Agent</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">User</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Mode</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">In (←model)</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Out (→model)</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Dur</th>
              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Est. Cost</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!isLoading && filteredLogs.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {isClientFiltered ? 'No results match the current filters.' : 'No usage logs yet. Start a chat to see data here.'}
                </td>
              </tr>
            )}
            {filteredLogs.map(log => (
              <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(log.created_at)}
                </td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className={`text-[10px] h-5 ${sourceBadgeClass(log.source)}`}>
                    {log.source ?? 'chat'}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs font-medium">
                  {log.agent?.name ?? (log.agent_id
                    ? <span className="text-muted-foreground font-normal">{log.agent_id.slice(0, 8)}</span>
                    : <span className="text-muted-foreground font-normal italic">—</span>
                  )}
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
                <td className="px-3 py-2 text-xs text-right text-muted-foreground font-mono whitespace-nowrap">
                  {log.duration_ms != null ? `${(log.duration_ms / 1000).toFixed(1)}s` : '—'}
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
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total > 0
            ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString()} entries`
            : '0 entries'}
          {isClientFiltered && ` — ${filteredLogs.length} shown after filter`}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={page === 0}
            onClick={() => setPage(0)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="px-2 text-xs">
            Page {page + 1} / {Math.max(totalPages, 1)}
          </span>
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(ProjectUsagePage, 'settings:read')
