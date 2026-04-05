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
} from '@jiku/ui'

interface MemoryBrowserProps {
  projectId: string
}

const SCOPE_LABELS: Record<string, string> = {
  agent_caller: 'User-Scoped',
  agent_global: 'Agent-Global',
  runtime_global: 'Project-Global',
}

const TIER_LABELS: Record<string, string> = {
  core: 'Core',
  extended: 'Extended',
}

const IMPORTANCE_COLORS: Record<string, 'secondary' | 'default' | 'destructive'> = {
  low: 'secondary',
  medium: 'secondary',
  high: 'default',
}

function MemoryCard({ memory, onDelete }: { memory: MemoryItem; onDelete: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-xs font-normal">
            {SCOPE_LABELS[memory.scope] ?? memory.scope}
          </Badge>
          <Badge variant={memory.tier === 'core' ? 'default' : 'secondary'} className="text-xs font-normal">
            {TIER_LABELS[memory.tier] ?? memory.tier}
          </Badge>
          <Badge variant={IMPORTANCE_COLORS[memory.importance] ?? 'secondary'} className="text-xs font-normal">
            {memory.importance}
          </Badge>
          {memory.section && (
            <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
              {memory.section}
            </Badge>
          )}
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
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
              <AlertDialogAction onClick={() => onDelete(memory.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="text-sm leading-relaxed">{memory.content}</p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
        <span>Accessed {memory.access_count}×</span>
        {memory.last_accessed && (
          <span>Last: {new Date(memory.last_accessed).toLocaleDateString()}</span>
        )}
        {memory.created_at && (
          <span>Created: {new Date(memory.created_at).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  )
}

export function MemoryBrowser({ projectId }: MemoryBrowserProps) {
  const qc = useQueryClient()
  const [scope, setScope] = useState<string>('all')
  const [tier, setTier] = useState<string>('all')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['memories', projectId, scope, tier],
    queryFn: () => api.memory.list(projectId, {
      scope: scope !== 'all' ? scope : undefined,
      tier: tier !== 'all' ? tier : undefined,
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

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b">
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="w-44 h-8 text-sm">
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
          <SelectTrigger className="w-36 h-8 text-sm">
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

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        ) : memories.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Brain className="h-10 w-10 opacity-30" />
            <p className="text-sm">No memories stored yet.</p>
            <p className="text-xs opacity-70">Memories are created automatically as agents interact with users.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {memories.map(m => (
              <MemoryCard
                key={m.id}
                memory={m}
                onDelete={(id) => deleteMutation.mutate(id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
