'use client'

import { use } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { ConnectorBinding, ConnectorItem } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
} from '@jiku/ui'
import { ArrowLeft, Plus, Settings2, Trash2, Webhook, Users, Play, Square } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ company: string; project: string; connector: string }>
}

function BindingCard({
  binding,
  base,
  onDelete,
}: {
  binding: ConnectorBinding
  base: string
  onDelete: () => void
}) {
  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg border bg-card group">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{binding.display_name ?? `Binding ${binding.id.slice(0, 8)}`}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{binding.trigger_source} · {binding.trigger_mode}</span>
          <span>·</span>
          <span>{binding.adapter_type}</span>
          {!binding.enabled && <Badge variant="secondary" className="text-[10px]">Disabled</Badge>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="h-7 text-xs" asChild>
          <Link href={`${base}/bindings/${binding.id}`}>
            <Settings2 className="h-3 w-3" />
            Detail
          </Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}

export default function ConnectorDetailPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, connector: connectorId } = use(params)
  const qc = useQueryClient()

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/channels/${connectorId}`

  const { data: connectorData, isLoading } = useQuery({
    queryKey: ['connector', connectorId],
    queryFn: () => api.connectors.get(connectorId),
  })

  const { data: bindingsData } = useQuery({
    queryKey: ['connector-bindings', connectorId],
    queryFn: () => api.connectors.bindings.list(connectorId),
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents-for-connector'],
    queryFn: async () => {
      // Get project from connector
      if (!connectorData?.connector.project_id) return { agents: [] }
      return api.agents.list(connectorData.connector.project_id)
    },
    enabled: !!connectorData?.connector.project_id,
  })

  const createBindingMutation = useMutation({
    mutationFn: (agentId: string) => api.connectors.bindings.create(connectorId, {
      agent_id: agentId,
      display_name: `Binding to ${agentsData?.agents.find(a => a.id === agentId)?.name ?? agentId}`,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] }),
  })

  const deleteBindingMutation = useMutation({
    mutationFn: (bindingId: string) => api.connectors.bindings.delete(connectorId, bindingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] }),
  })

  const activateMutation = useMutation({
    mutationFn: () => api.connectors.activate(connectorId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector', connectorId] }),
  })

  const deactivateMutation = useMutation({
    mutationFn: () => api.connectors.deactivate(connectorId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector', connectorId] }),
  })

  const connector = connectorData?.connector
  const bindings = bindingsData?.bindings ?? []
  const agents = agentsData?.agents ?? []

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (!connector) return <div className="p-6 text-sm text-destructive">Connector not found</div>

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" asChild>
          <Link href={`/studio/companies/${companySlug}/projects/${projectSlug}/channels`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Webhook className="h-5 w-5" />
            {connector.display_name}
          </h1>
          <p className="text-xs text-muted-foreground">{connector.plugin_id}</p>
        </div>
        <Badge
          variant="outline"
          className={
            connector.status === 'active' ? 'text-green-600 border-green-500/40' :
            connector.status === 'error' ? 'text-destructive border-destructive/40' :
            'text-muted-foreground'
          }
        >
          {connector.status}
        </Badge>
        {connector.credential_id && connector.status !== 'active' && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 text-green-600 border-green-500/40"
            onClick={() => activateMutation.mutate()}
            disabled={activateMutation.isPending}
          >
            <Play className="h-3 w-3" />
            {activateMutation.isPending ? 'Starting...' : 'Start'}
          </Button>
        )}
        {connector.status === 'active' && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 text-destructive border-destructive/40"
            onClick={() => deactivateMutation.mutate()}
            disabled={deactivateMutation.isPending}
          >
            <Square className="h-3 w-3" />
            {deactivateMutation.isPending ? 'Stopping...' : 'Stop'}
          </Button>
        )}
      </div>
      {connector.error_message && (
        <p className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded px-3 py-2">
          {connector.error_message}
        </p>
      )}

      {/* Quick nav */}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
          <Link href={`${base}/events`}>Events</Link>
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
          <Link href={`${base}/messages`}>Messages</Link>
        </Button>
      </div>

      <Separator />

      {/* Bindings */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Users className="h-4 w-4" />
            Bindings
            <Badge variant="secondary" className="ml-1">{bindings.length}</Badge>
          </h2>
          {agents.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                className="h-7 text-xs border rounded px-2 bg-background"
                onChange={e => {
                  if (e.target.value) {
                    createBindingMutation.mutate(e.target.value)
                    e.target.value = ''
                  }
                }}
                defaultValue=""
              >
                <option value="" disabled>Add binding to agent...</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <Plus className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
        </div>

        {bindings.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">No bindings yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Add a binding to route events from this connector to an agent.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {bindings.map(binding => (
              <BindingCard
                key={binding.id}
                binding={binding}
                base={base}
                onDelete={() => {
                  if (confirm('Delete this binding?')) {
                    deleteBindingMutation.mutate(binding.id)
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Config display */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium">Configuration</h2>
        <Card>
          <CardContent className="p-4">
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
              {JSON.stringify(
                Object.fromEntries(
                  Object.entries(connector.config).map(([k, v]) =>
                    k.includes('token') || k.includes('secret') ? [k, '••••••'] : [k, v]
                  )
                ),
                null, 2
              )}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
