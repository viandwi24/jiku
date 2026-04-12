'use client'

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, Trash2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, type MemoryItem } from '@/lib/api'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
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

// Plan 19
const TYPE_COLORS: Record<string, string> = {
  episodic:   'text-slate-600 border-slate-500/40 bg-slate-500/5',
  semantic:   'text-blue-600 border-blue-500/40 bg-blue-500/5',
  procedural: 'text-teal-600 border-teal-500/40 bg-teal-500/5',
  reflective: 'text-purple-600 border-purple-500/40 bg-purple-500/5',
}

const SOURCE_TYPE_LABEL: Record<string, string> = {
  tool: 'tool',
  reflection: 'reflect',
  dream: 'dream',
  flush: 'flush',
}

function healthBarColor(h: number): string {
  if (h >= 0.8) return 'bg-emerald-500'
  if (h >= 0.5) return 'bg-amber-500'
  if (h >= 0.2) return 'bg-orange-500'
  return 'bg-destructive'
}

function MemoryRow({
  memory,
  agentName,
  onDelete,
  onOpen,
}: {
  memory: MemoryItem
  agentName: string | null
  onDelete: (id: string) => void
  onOpen: (m: MemoryItem) => void
}) {
  return (
    <tr
      className="group border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
      onClick={() => onOpen(memory)}
    >
      {/* Scope */}
      <td className="px-4 py-2 w-20 shrink-0">
        <Badge
          variant="outline"
          className={`text-[10px] font-mono font-normal px-1.5 ${SCOPE_COLORS[memory.scope] ?? ''}`}
        >
          {SCOPE_LABELS[memory.scope] ?? memory.scope}
        </Badge>
      </td>

      {/* Plan 19 — Type + source_type hint */}
      <td className="px-2 py-2 w-24">
        {memory.memory_type && (
          <Badge
            variant="outline"
            className={`text-[10px] font-mono font-normal px-1.5 ${TYPE_COLORS[memory.memory_type] ?? ''}`}
            title={memory.source_type ? `from ${SOURCE_TYPE_LABEL[memory.source_type] ?? memory.source_type}` : undefined}
          >
            {memory.memory_type}
          </Badge>
        )}
      </td>

      {/* Agent */}
      <td className="px-2 py-2 w-32">
        {agentName ? (
          <span className="text-xs text-foreground truncate block max-w-30">{agentName}</span>
        ) : memory.agent_id ? (
          <span className="text-[10px] text-muted-foreground font-mono truncate block max-w-30">
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

      {/* Plan 19 — Health */}
      <td className="px-2 py-2 w-20">
        {memory.score_health != null ? (
          <div className="flex items-center gap-1.5" title={`score_health = ${memory.score_health.toFixed(2)}`}>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full ${healthBarColor(memory.score_health)}`}
                style={{ width: `${Math.min(100, Math.max(0, memory.score_health * 100))}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
              {memory.score_health.toFixed(2)}
            </span>
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>

      {/* Section */}
      <td className="px-2 py-2 w-24">
        {memory.section && (
          <span className="text-[10px] text-muted-foreground font-mono truncate block max-w-22.5">
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
      <td className="px-3 py-2 w-10" onClick={(e) => e.stopPropagation()}>
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
  const [selected, setSelected] = useState<MemoryItem | null>(null)

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
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-24">Type</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-32">Agent</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-20">Tier</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-16">Priority</th>
                <th className="px-2 py-2 text-left text-xs font-medium text-muted-foreground w-20">Health</th>
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
                  onOpen={setSelected}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <MemoryDetailDialog
        memory={selected}
        agentName={selected?.agent_id ? (agentNameMap.get(selected.agent_id) ?? null) : null}
        onClose={() => setSelected(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['memories', projectId] })
          setSelected(null)
        }}
        onDeleted={() => {
          qc.invalidateQueries({ queryKey: ['memories', projectId] })
          setSelected(null)
        }}
      />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Plan 19 — Memory detail / edit dialog
// ──────────────────────────────────────────────────────────────

function MemoryDetailDialog({
  memory,
  agentName,
  onClose,
  onSaved,
  onDeleted,
}: {
  memory: MemoryItem | null
  agentName: string | null
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [content, setContent] = useState('')
  const [importance, setImportance] = useState<'low' | 'medium' | 'high'>('medium')
  const [visibility, setVisibility] = useState<'private' | 'agent_shared' | 'project_shared'>('private')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!memory) return
    setContent(memory.content)
    setImportance(memory.importance)
    setVisibility(memory.visibility)
  }, [memory])

  if (!memory) return null

  const dirty = content !== memory.content || importance !== memory.importance || visibility !== memory.visibility

  const save = async () => {
    if (!dirty || !content.trim()) return
    setSaving(true)
    try {
      await api.memory.update(memory.id, { content: content.trim(), importance, visibility })
      toast.success('Memory updated')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update memory')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await api.memory.delete(memory.id)
      toast.success('Memory deleted')
      onDeleted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
    }
  }

  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleString() : '—'

  return (
    <Dialog open={!!memory} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Memory detail</DialogTitle>
          <DialogDescription className="text-xs">
            Edit content, importance, and visibility. Scope/tier/agent are immutable.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 text-[11px] rounded-md border bg-muted/30 p-3">
          <div><span className="text-muted-foreground">Scope:</span> <span className="font-mono">{memory.scope}</span></div>
          <div><span className="text-muted-foreground">Tier:</span> <span className="font-mono">{memory.tier}</span></div>
          <div><span className="text-muted-foreground">Agent:</span> {agentName ?? (memory.agent_id?.slice(0, 8) ?? '—')}</div>
          <div><span className="text-muted-foreground">Caller:</span> {memory.caller_id ?? '—'}</div>
          {memory.memory_type && (
            <div><span className="text-muted-foreground">Type:</span> <span className="font-mono">{memory.memory_type}</span></div>
          )}
          {memory.source_type && (
            <div><span className="text-muted-foreground">Source:</span> <span className="font-mono">{memory.source_type}</span></div>
          )}
          {memory.score_health != null && (
            <div><span className="text-muted-foreground">Health:</span> <span className="font-mono">{memory.score_health.toFixed(2)}</span></div>
          )}
          <div><span className="text-muted-foreground">Access count:</span> {memory.access_count}×</div>
          <div><span className="text-muted-foreground">Created:</span> {fmtDate(memory.created_at)}</div>
          <div><span className="text-muted-foreground">Updated:</span> {fmtDate(memory.updated_at)}</div>
          <div><span className="text-muted-foreground">Last accessed:</span> {fmtDate(memory.last_accessed)}</div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium">Content</Label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            className="text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-medium">Importance</Label>
            <Select value={importance} onValueChange={(v) => setImportance(v as typeof importance)}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Visibility</Label>
            <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="private">private</SelectItem>
                <SelectItem value="agent_shared">agent_shared</SelectItem>
                <SelectItem value="project_shared">project_shared</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={deleting}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete memory?</AlertDialogTitle>
                <AlertDialogDescription>
                  This memory entry will be permanently removed. The agent will no longer recall this information.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={remove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving || !content.trim()}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
