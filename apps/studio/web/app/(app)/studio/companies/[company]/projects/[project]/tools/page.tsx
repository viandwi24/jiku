'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ResolvedToolItem, McpServerItem } from '@/lib/api'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@jiku/ui'
import { Plus, Plug2, RefreshCcw, Trash2, Wrench, Zap } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

// ─── Tool Inventory Tab ────────────────────────────────────────────────────

function ToolsTab({ projectId }: { projectId: string }) {
  const [search, setSearch] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['resolved-tools', projectId],
    queryFn: () => api.resolvedTools.list(projectId),
    enabled: !!projectId,
  })

  const tools = data?.tools ?? []
  const filtered = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase())
        || t.id.toLowerCase().includes(search.toLowerCase())
        || (t.group ?? '').toLowerCase().includes(search.toLowerCase())
        || t.source_label.toLowerCase().includes(search.toLowerCase()),
      )
    : tools

  // Group tools by meta.group (null → "Ungrouped")
  const grouped = new Map<string, ResolvedToolItem[]>()
  for (const t of filtered) {
    const g = t.group ?? 'ungrouped'
    const arr = grouped.get(g) ?? []
    arr.push(t)
    grouped.set(g, arr)
  }
  const sortedGroups = [...grouped.entries()].sort(([a], [b]) => {
    if (a === 'ungrouped') return 1
    if (b === 'ungrouped') return -1
    return a.localeCompare(b)
  })

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">Loading tools...</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm max-w-xs"
        />
        <span className="text-xs text-muted-foreground">{tools.length} tools</span>
      </div>

      {sortedGroups.map(([group, items]) => (
        <div key={group}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            {group}
          </h3>
          <div className="border rounded-lg divide-y">
            {items.map((t) => (
              <div key={t.id} className="p-3 flex items-start gap-3">
                <Wrench className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{t.name}</span>
                    <code className="text-xs text-muted-foreground">{t.id}</code>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.description}</p>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {t.modes.map((m) => (
                      <Badge key={m} variant="secondary" className="text-[10px] px-1.5 py-0">
                        {m}
                      </Badge>
                    ))}
                    <Badge
                      variant={t.source_type === 'mcp' ? 'default' : 'outline'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {t.source_type === 'mcp' ? `MCP · ${t.source_label}` : t.source_label}
                    </Badge>
                    {t.side_effectful && (
                      <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                        side-effect
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {sortedGroups.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {search ? 'No tools match your search.' : 'No tools registered for this project.'}
        </p>
      )}
    </div>
  )
}

// ─── MCP Servers Tab ───────────────────────────────────────────────────────

function MCPTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formTransport, setFormTransport] = useState<'sse' | 'streamable-http'>('sse')
  const [formUrl, setFormUrl] = useState('')
  const [formEnabled, setFormEnabled] = useState(true)

  const { data, isLoading } = useQuery({
    queryKey: ['mcp-servers', projectId],
    queryFn: () => api.mcpServers.list(projectId),
    enabled: !!projectId,
  })
  const servers = data?.servers ?? []

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mcp-servers', projectId] })

  const createMut = useMutation({
    mutationFn: () => api.mcpServers.create(projectId, {
      name: formName.trim(),
      transport: formTransport,
      config: { url: formUrl.trim() },
      enabled: formEnabled,
    }),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['resolved-tools', projectId] })
      setShowForm(false)
      setFormName('')
      setFormUrl('')
      toast.success('MCP server added')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.mcpServers.delete(id),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['resolved-tools', projectId] })
      toast.success('MCP server deleted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.mcpServers.update(id, { enabled }),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['resolved-tools', projectId] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Toggle failed'),
  })

  const testMut = useMutation({
    mutationFn: (id: string) => api.mcpServers.test(id),
    onSuccess: (d) => {
      if (d.success) {
        toast.success(`Connected — ${d.tool_count} tool(s) discovered`)
        invalidate()
      } else {
        toast.error(`Connection failed: ${d.error}`)
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Test failed'),
  })

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">Loading...</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Remote MCP servers provide additional tools to agents. Only SSE and Streamable HTTP transports
          are supported (no stdio — stateless multi-tenant requirement).
        </p>
        <Button size="sm" variant="outline" onClick={() => setShowForm(v => !v)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Server
        </Button>
      </div>

      {showForm && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Name</Label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. My RAG Server"
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Transport</Label>
            <Select value={formTransport} onValueChange={(v) => setFormTransport(v as 'sse' | 'streamable-http')}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sse">SSE</SelectItem>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">URL</Label>
            <Input
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder={formTransport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'}
              className="text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
            <span className="text-xs">Auto-connect on save</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!formName.trim() || !formUrl.trim() || createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              {createMut.isPending ? 'Adding...' : 'Add'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {servers.length > 0 ? (
        <div className="border rounded-lg divide-y">
          {servers.map((s) => (
            <div key={s.id} className="p-3 flex items-center gap-3">
              <Plug2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  <Badge variant={s.connected ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
                    {s.connected ? `Connected · ${s.tool_count} tools` : 'Disconnected'}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{s.transport}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {(s.config as { url?: string }).url ?? 'no url'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => testMut.mutate(s.id)}
                  disabled={testMut.isPending}
                  title="Test connection"
                >
                  <Zap className="h-3.5 w-3.5" />
                </Button>
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(enabled) => toggleMut.mutate({ id: s.id, enabled })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Delete MCP server "${s.name}"?`)) deleteMut.mutate(s.id)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : !showForm ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No MCP servers configured. Add one to extend your agents with external tools.
        </p>
      ) : null}
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function ToolsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)

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

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div>
        <h1 className="text-base font-semibold flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          Tools
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          All tools available to agents in this project — from plugins and MCP servers.
        </p>
      </div>

      <Tabs defaultValue="tools">
        <TabsList>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="mcp">MCP Servers</TabsTrigger>
        </TabsList>
        <TabsContent value="tools" className="mt-4">
          {projectId && <ToolsTab projectId={projectId} />}
        </TabsContent>
        <TabsContent value="mcp" className="mt-4">
          {projectId && <MCPTab projectId={projectId} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}
