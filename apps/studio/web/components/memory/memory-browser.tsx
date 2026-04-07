'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, Trash2, RefreshCw } from 'lucide-react'
import { api, type MemoryItem } from '@/lib/api'
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@jiku/ui'

interface MemoryBrowserProps {
  projectId: string
}

const SCOPE_LABELS: Record<string, string> = {
  agent_caller: 'User',
  agent_global: 'Agent',
  runtime_global: 'Project',
  agent_self: 'Self',
}

const SCOPE_COLORS: Record<string, string> = {
  agent_caller: 'text-blue-600 border-blue-500/40 bg-blue-500/5',
  agent_global: 'text-violet-600 border-violet-500/40 bg-violet-500/5',
  runtime_global: 'text-emerald-600 border-emerald-500/40 bg-emerald-500/5',
  agent_self: 'text-amber-600 border-amber-500/40 bg-amber-500/5',
}

const IMPORTANCE_COLORS: Record<string, string> = {
  low: 'text-muted-foreground',
  medium: 'text-amber-600',
  high: 'text-red-600',
}

function MemoryRow({
  memory,
  agentName,
  onDelete,
}: {
  memory: MemoryItem
  agentName: string | null
  onDelete: (id: string) => void
}) {
  return (
    <tr className="group border-b last:border-0 hover:bg-muted/30 transition-colors">
      {/* Scope */}
      <td className="px-4 py-2 w-20 shrink-0">
        <Badge
          variant="outline"
          className={`text-[10px] font-mono font-normal px-1.5 ${SCOPE_COLORS[memory.scope] ?? ''}`}
        >
          {SCOPE_LABELS[memory.scope] ?? memory.scope}
        </Badge>
      </td>

      {/* Agent */}
      <td className="px-2 py-2 w-32">
        {agentName ? (
          <span className="text-xs text-foreground truncate block max-w-[120px]">{agentName}</span>
        ) : memory.agent_id ? (
          <span className="text-[10px] text-muted-foreground font-mono truncate block max-w-[120px]">
            {memory.agent_id.slice(0, 8)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>

      {/* Tier */}
      <td className="px-2 py-2 w-20">
        <Badge
          variant={memory.tier === 'core' ? 'default' : 'secondary'}
          className="text-[10px] font-normal px-1.5"
        >
          {memory.tier}
        </Badge>
      </td>

      {/* Importance */}
      <td className="px-2 py-2 w-16 text-center">
        <span className={`text-[10px] font-medium ${IMPORTANCE_COLORS[memory.importance] ?? ''}`}>
          {memory.importance}
        </span>
      </td>

      {/* Section */}
      <td className="px-2 py-2 w-24">
        {memory.section && (
          <span className="text-[10px] text-muted-foreground font-mono truncate block max-w-[90px]">
            {memory.section}
          </span>
        )}
      </td>

      {/* Content */}
      <td className="px-2 py-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="text-sm text-foreground truncate max-w-xl cursor-default">
                {memory.content}
              </p>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap text-xs">
              {memory.content}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </td>

      {/* Access count */}
      <td className="px-2 py-2 w-16 text-right">
        <span className="text-xs text-muted-foreground tabular-nums">{memory.access_count}×</span>
      </td>

      {/* Created */}
      <td className="px-2 py-2 w-24 text-right">
        {memory.created_at && (
          <span className="text-xs text-muted-foreground">
            {new Date(memory.created_at).toLocaleDateString()}
          </span>
        )}
      </td>

      {/* Delete */}
      <td className="px-3 py-2 w-10">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete memory?</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogDescription>
              This memory entry will be permanently removed. The agent will no longer recall this information.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete(memory.id)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  )
}

export function MemoryBrowser({ projectId }: MemoryBrowserProps) {
  const qc = useQueryClient()
  const [scope, setScope] = useState<string>('all')
  const [tier, setTier] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')

  const { data: agentsData } = useQuery({
    queryKey: ['agents-for-memory', projectId],
    queryFn: () => api.agents.list(projectId),
  })
  const agents = agentsData?.agents ?? []

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['memories', projectId, scope, tier, agentFilter],
    queryFn: () => api.memory.list(projectId, {
      scope: scope !== 'all' ? scope : undefined,
      tier: tier !== 'all' ? tier : undefined,
      agent_id: agentFilter !== 'all' ? agentFilter : undefined,
      limit: 100,
    }),
    staleTime: 0,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.memory.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', projectId] })
    },
  })

  const memories = data?.memories ?? []

  const agentNameMap = new Map(agents.map(a => [a.id, a.name]))

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b flex-wrap">
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue placeholder="All scopes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scopes</SelectItem>
            <SelectItem value="agent_caller">User-Scoped</SelectItem>
            <SelectItem value="agent_global">Agent-Global</SelectItem>
            <SelectItem value="runtime_global">Project-Global</SelectItem>
          </SelectContent>
        </Select>

        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger className="w-32 h-8 text-sm">
            <SelectValue placeholder="All tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            <SelectItem value="core">Core</SelectItem>
            <SelectItem value="extended">Extended</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{memories.length} entries</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col gap-0.5 px-6 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded" />
            ))}
          </div>
        ) : memories.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Brain className="h-10 w-10 opacity-30" />
            <p className="text-sm">No memories stored yet.</p>
            <p className="text-xs opacity-70">Memories are created automatically as agents interact with users.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground w-20">Scope</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-32">Agent</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-20">Tier</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-16">Priority</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-24">Section</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground">Content</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-muted-foreground w-16">Hits</th>
                <th className="px-2 py-2 text-right text-xs font-medium text-muted-foreground w-24">Created</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {memories.map(m => (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  agentName={m.agent_id ? (agentNameMap.get(m.agent_id) ?? null) : null}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
