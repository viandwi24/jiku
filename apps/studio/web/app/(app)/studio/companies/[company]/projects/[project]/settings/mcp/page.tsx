'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type McpServerItem } from '@/lib/api'
import {
  Badge, Button, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Switch,
} from '@jiku/ui'
import { Plus, Plug, Trash2, Zap } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function McpServersPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)
  const projectId = project?.id ?? ''

  const { data: serversData, isLoading } = useQuery({
    queryKey: ['mcp-servers', projectId],
    queryFn: () => api.mcpServers.list(projectId),
    enabled: !!projectId,
  })

  const servers = serversData?.servers ?? []

  // Add server form
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTransport, setNewTransport] = useState('streamable-http')
  const [newUrl, setNewUrl] = useState('')

  const createMutation = useMutation({
    mutationFn: () => api.mcpServers.create(projectId, {
      name: newName,
      transport: newTransport,
      config: { url: newUrl },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-servers', projectId] })
      setShowAdd(false)
      setNewName('')
      setNewUrl('')
      toast.success('MCP server added')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.mcpServers.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-servers', projectId] })
      toast.success('MCP server removed')
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.mcpServers.update(id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-servers', projectId] })
    },
  })

  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; tool_count?: number; error?: string }>>({})

  async function testServer(id: string) {
    setTestingId(id)
    try {
      const result = await api.mcpServers.test(id)
      setTestResult(prev => ({ ...prev, [id]: result }))
      if (result.success) {
        toast.success(`Connected — ${result.tool_count} tool(s) found`)
      } else {
        toast.error(`Connection failed: ${result.error}`)
      }
    } catch {
      toast.error('Test failed')
    } finally {
      setTestingId(null)
    }
  }

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">MCP Servers</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Connect external tool servers via Model Context Protocol. Tools from MCP servers are available to all agents.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Server
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="My MCP Server" className="text-sm h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Transport</Label>
              <Select value={newTransport} onValueChange={setNewTransport}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                  <SelectItem value="stdio">Stdio (local)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{newTransport === 'stdio' ? 'Command' : 'URL'}</Label>
            <Input
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              placeholder={newTransport === 'stdio' ? 'npx @modelcontextprotocol/server-example' : 'https://mcp.example.com/mcp'}
              className="text-sm h-8"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createMutation.mutate()} disabled={!newName || !newUrl || createMutation.isPending}>
              {createMutation.isPending ? 'Adding...' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {/* Server list */}
      {servers.length === 0 && !showAdd ? (
        <div className="border border-dashed rounded-lg py-10 text-center">
          <Plug className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
          <p className="text-xs text-muted-foreground mt-1">Add a server to extend agent capabilities with external tools.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map(server => {
            const test = testResult[server.id]
            return (
              <div key={server.id} className="border rounded-lg p-4">
                <div className="flex items-center gap-3">
                  <Plug className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{server.name}</span>
                      <Badge variant="outline" className="text-[10px]">{server.transport}</Badge>
                      {server.connected && (
                        <Badge variant="outline" className="text-[10px] text-green-600 border-green-500/40 bg-green-500/5">
                          connected · {server.tool_count} tools
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {(server.config as Record<string, unknown>)?.url as string ?? (server.config as Record<string, unknown>)?.command as string ?? '—'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => testServer(server.id)}
                    disabled={testingId === server.id}
                  >
                    <Zap className="h-3 w-3 mr-1" />
                    {testingId === server.id ? 'Testing...' : 'Test'}
                  </Button>
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={v => toggleMutation.mutate({ id: server.id, enabled: v })}
                  />
                  <button
                    onClick={() => deleteMutation.mutate(server.id)}
                    className="text-muted-foreground hover:text-destructive transition-colors p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {test && !test.success && (
                  <p className="text-xs text-destructive mt-2">Error: {test.error}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
