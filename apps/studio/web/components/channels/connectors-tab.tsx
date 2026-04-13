'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@jiku/ui'
import { Webhook, Plus, AlertCircle, CheckCircle2, Circle, Trash2, Settings, Activity, MessageSquare } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectorItem } from '@/lib/api'

function StatusBadge({ status }: { status: ConnectorItem['status'] }) {
  if (status === 'active') return (
    <Badge variant="outline" className="gap-1 text-green-600 border-green-500/40 bg-green-500/5">
      <CheckCircle2 className="h-3 w-3" /> Active
    </Badge>
  )
  if (status === 'error') return (
    <Badge variant="outline" className="gap-1 text-destructive border-destructive/40 bg-destructive/5">
      <AlertCircle className="h-3 w-3" /> Error
    </Badge>
  )
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Circle className="h-3 w-3" /> Inactive
    </Badge>
  )
}

interface ConnectorsTabProps {
  projectId: string
  baseUrl: string
}

export function ConnectorsTab({ projectId, baseUrl }: ConnectorsTabProps) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.connectors.list(projectId),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.connectors.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors', projectId] }),
  })

  const connectors = data?.connectors ?? []

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading connectors...</p>

  if (connectors.length === 0) return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
        <Webhook className="h-10 w-10 text-muted-foreground/30" />
        <p className="text-sm font-medium">No connectors yet</p>
        <p className="text-xs text-muted-foreground text-center max-w-xs">
          Add a connector to let your agents receive messages from Telegram, Discord, and more.
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link href={`${baseUrl}/channels/new`}>
            <Plus className="h-4 w-4" />
            Add your first connector
          </Link>
        </Button>
      </CardContent>
    </Card>
  )

  return (
    <div className="grid gap-4">
      {connectors.map(connector => (
        <Card key={connector.id} className="group">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                  <Webhook className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-sm font-medium">{connector.display_name}</CardTitle>
                  <CardDescription className="text-xs">{connector.plugin_id}</CardDescription>
                </div>
              </div>
              <StatusBadge status={connector.status} />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {connector.error_message && (
              <p className="text-xs text-destructive mb-3 flex items-center gap-1">
                <AlertCircle className="h-3 w-3 shrink-0" />
                {connector.error_message}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                <Link href={`${baseUrl}/channels/${connector.id}`}>
                  <Settings className="h-3 w-3" />
                  Manage
                </Link>
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                <Link href={`${baseUrl}/channels?tab=events&connector_id=${connector.id}`}>
                  <Activity className="h-3 w-3" />
                  Events
                </Link>
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                <Link href={`${baseUrl}/channels?tab=messages&connector_id=${connector.id}`}>
                  <MessageSquare className="h-3 w-3" />
                  Messages
                </Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive hover:text-destructive ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => {
                  if (confirm('Delete this connector?')) {
                    deleteMutation.mutate(connector.id)
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
