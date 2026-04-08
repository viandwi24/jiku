'use client'

import { use, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { UsageLog } from '@/lib/api'
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@jiku/ui'
import { BarChart2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { aggregateByDay, buildPricingMap, estimateCost, estimateTotalCost, formatTokens } from '@/lib/usage'
import { TokenUsageAreaChart } from '@/components/usage/usage-charts'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

function formatDate(d: string): string {
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function RawDataDialog({ log }: { log: UsageLog }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        Raw
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono">Raw Data — {log.id.slice(0, 8)}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto space-y-4 text-xs font-mono">
            <div>
              <p className="text-muted-foreground mb-1">System Prompt</p>
              <pre className="bg-muted rounded p-3 whitespace-pre-wrap wrap-break-word">
                {log.raw_system_prompt ?? '(not captured)'}
              </pre>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Messages</p>
              <pre className="bg-muted rounded p-3 whitespace-pre-wrap wrap-break-word">
                {log.raw_messages ? JSON.stringify(log.raw_messages, null, 2) : '(not captured)'}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default function UsagePage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const [page, setPage] = useState(0)
  const pageSize = 50

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

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['usage', agentId, page],
    queryFn: () => api.agents.usage(agentId!, { limit: pageSize, offset: page * pageSize }),
    enabled: !!agentId,
    refetchInterval: 5000,
  })

  const { data: adaptersData } = useQuery({
    queryKey: ['adapters', 'provider-model'],
    queryFn: () => api.credentials.adapters('provider-model'),
    staleTime: 60_000,
  })
  const pricingMap = useMemo(() => buildPricingMap(adaptersData?.adapters ?? []), [adaptersData])

  const logs = data?.logs ?? []
  const summary = data?.summary
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / pageSize)

  const totalTokens = (summary?.total_input ?? 0) + (summary?.total_output ?? 0)
  const estimatedCost = useMemo(() => estimateTotalCost(logs, pricingMap), [logs, pricingMap])
  const dailyData = useMemo(() => aggregateByDay(logs), [logs])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            Usage Monitor
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Token usage per run. Raw system prompt and messages available for debugging.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-5 gap-3">
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Total Runs</p>
            <p className="text-2xl font-semibold">{summary.total_runs.toLocaleString()}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Token In (from model)</p>
            <p className="text-2xl font-semibold">{formatTokens(summary.total_output)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Token Out (to model)</p>
            <p className="text-2xl font-semibold">{formatTokens(summary.total_input)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Total Tokens</p>
            <p className="text-2xl font-semibold">{formatTokens(totalTokens)}</p>
          </div>
          <div className="border rounded-lg p-4 space-y-0.5">
            <p className="text-xs text-muted-foreground">Estimated Cost</p>
            <p className="text-2xl font-semibold">{estimatedCost}</p>
          </div>
        </div>
      )}

      {/* Token usage chart */}
      {logs.length > 0 && <TokenUsageAreaChart data={dailyData} />}

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
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
                <td colSpan={8} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!isLoading && logs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No usage logs yet. Start a chat to see data here.
                </td>
              </tr>
            )}
            {logs.map(log => (
              <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(log.created_at)}
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
          <span>Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}</span>
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
