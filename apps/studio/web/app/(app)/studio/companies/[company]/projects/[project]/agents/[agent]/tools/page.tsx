'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Input, Switch, cn } from '@jiku/ui'
import { ChevronDown, Search, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import type { PreviewRunResult } from '@/lib/api'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

type Tool = PreviewRunResult['active_tools'][number]

function modeColor(mode: string) {
  if (mode === 'chat') return 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
  if (mode === 'task') return 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
  return 'bg-muted text-muted-foreground'
}

function groupLabel(t: Tool): string {
  if (t.group) return t.group
  if (t.id.startsWith('__builtin__:')) return 'built-in'
  const colon = t.id.indexOf(':')
  return colon > -1 ? t.id.slice(0, colon) : 'plugin'
}

function schemaToParams(schema: unknown) {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as Record<string, unknown>
  const properties = s['properties'] as Record<string, Record<string, unknown>> | undefined
  const required = (s['required'] as string[] | undefined) ?? []
  if (!properties) return []
  return Object.entries(properties).map(([name, def]) => ({
    name,
    type: (def['type'] as string | undefined) ?? '?',
    description: (def['description'] as string | undefined) ?? '',
    required: required.includes(name),
  }))
}

function ToolRow({ t, enabled, onToggle }: { t: Tool; enabled: boolean; onToggle?: (enabled: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const params = schemaToParams(t.input_schema)

  return (
    <div className={cn("border border-border/40 rounded-lg overflow-hidden text-xs", !enabled && "opacity-50")}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          className="flex items-center gap-2 flex-1 min-w-0 hover:bg-muted/40 transition-colors text-left -mx-1 px-1 rounded"
          onClick={() => setOpen(o => !o)}
        >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-foreground">{t.name}</span>
            {t.has_prompt && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                hint
              </span>
            )}
          </div>
          {!open && t.description && (
            <p className="text-muted-foreground mt-0.5 truncate text-[11px]">{t.description}</p>
          )}
        </div>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')} />
        </button>
        {onToggle && (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            className="shrink-0"
          />
        )}
      </div>

      {open && (
        <div className="border-t border-border/30 bg-muted/10 divide-y divide-border/20">
          <div className="px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Description</p>
            <p className="text-[11px] text-foreground/80 leading-relaxed">{t.description || '—'}</p>
          </div>
          <div className="px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Parameters {params.length > 0 ? `(${params.length})` : ''}
            </p>
            {params.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">No parameters</p>
            ) : (
              <div className="space-y-1.5">
                {params.map(p => (
                  <div key={p.name} className="rounded-md bg-muted/40 px-2.5 py-2 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[11px] font-semibold">{p.name}</code>
                      <span className="text-[10px] px-1 py-px rounded bg-muted text-muted-foreground font-mono">{p.type}</span>
                      {p.required && <span className="text-[10px] px-1 py-px rounded bg-red-500/10 text-red-500">required</span>}
                    </div>
                    {p.description && <p className="text-[11px] text-muted-foreground leading-relaxed">{p.description}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ToolsList({ tools, toolStates, onToggle }: {
  tools: Tool[]
  toolStates?: { project: Record<string, boolean>; agent: Record<string, boolean> }
  onToggle?: (toolId: string, enabled: boolean) => void
}) {
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? tools.filter(t =>
        t.name.toLowerCase().includes(query.toLowerCase()) ||
        t.id.toLowerCase().includes(query.toLowerCase()) ||
        t.description.toLowerCase().includes(query.toLowerCase())
      )
    : tools

  const grouped = filtered.reduce<Record<string, Tool[]>>((acc, t) => {
    const g = groupLabel(t)
    if (!acc[g]) acc[g] = []
    acc[g].push(t)
    return acc
  }, {})

  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">No tools registered for this agent.</p>
  }

  return (
    <div className="space-y-3">
      {tools.length > 6 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter tools…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      )}
      {filtered.length === 0 && (
        <p className="text-xs text-muted-foreground">No tools match &quot;{query}&quot;</p>
      )}
      {Object.entries(grouped).map(([group, groupTools]) => (
        <div key={group} className="space-y-1">
          <div className="flex items-center gap-2 px-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
              {group} <span className="font-normal normal-case">({groupTools.length})</span>
            </p>
            <div className="flex gap-1">
              {['chat', 'task'].map(m => (
                <span key={m} className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono', modeColor(m))}>{m}</span>
              ))}
            </div>
          </div>
          {groupTools.map(t => {
            const agentState = toolStates?.agent[t.id]
            const projectState = toolStates?.project[t.id]
            const isEnabled = agentState !== undefined ? agentState : projectState !== undefined ? projectState : true
            return <ToolRow key={t.id} t={t} enabled={isEnabled} onToggle={onToggle ? (v) => onToggle(t.id, v) : undefined} />
          })}
        </div>
      ))}
    </div>
  )
}

export default function AgentToolsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id,
  })

  const currentAgent = agentsData?.agents.find(a => a.slug === agentSlug)

  const { data: preview } = useQuery({
    queryKey: ['preview', currentAgent?.id],
    queryFn: () => api.agents.preview(currentAgent!.id, { mode: 'chat' }),
    enabled: !!currentAgent?.id,
    staleTime: 60_000,
  })

  const queryClient = useQueryClient()

  const { data: toolStatesData } = useQuery({
    queryKey: ['tool-states', currentAgent?.id],
    queryFn: () => api.toolStates.get(currentAgent!.id),
    enabled: !!currentAgent?.id,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ toolId, enabled }: { toolId: string; enabled: boolean }) =>
      api.toolStates.set(currentAgent!.id, toolId, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tool-states', currentAgent?.id] })
      toast.success('Tool state updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  if (!currentAgent) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Available Tools</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          All tools registered for this agent. Toggle to enable/disable per agent.
        </p>
      </div>
      {!preview ? (
        <p className="text-xs text-muted-foreground">Loading tools…</p>
      ) : (
        <ToolsList
          tools={preview.active_tools}
          toolStates={toolStatesData?.states}
          onToggle={(toolId, enabled) => toggleMutation.mutate({ toolId, enabled })}
        />
      )}
    </div>
  )
}
