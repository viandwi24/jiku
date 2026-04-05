'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectorIdentity } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
} from '@jiku/ui'
import { ArrowLeft, CheckCircle2, XCircle, Clock, User } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ company: string; project: string; connector: string; binding: string }>
}

function IdentityStatusBadge({ status }: { status: ConnectorIdentity['status'] }) {
  if (status === 'approved') return (
    <Badge variant="outline" className="gap-1 text-green-600 border-green-500/40 bg-green-500/5 text-xs">
      <CheckCircle2 className="h-2.5 w-2.5" /> Approved
    </Badge>
  )
  if (status === 'blocked') return (
    <Badge variant="outline" className="gap-1 text-destructive border-destructive/40 text-xs">
      <XCircle className="h-2.5 w-2.5" /> Blocked
    </Badge>
  )
  return (
    <Badge variant="outline" className="gap-1 text-amber-600 border-amber-500/40 text-xs">
      <Clock className="h-2.5 w-2.5" /> Pending
    </Badge>
  )
}

export default function BindingDetailPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, connector: connectorId, binding: bindingId } = use(params)
  const qc = useQueryClient()

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/channels/${connectorId}`

  const { data: bindingData, isLoading } = useQuery({
    queryKey: ['connector-binding', bindingId],
    queryFn: () => api.connectors.bindings.list(connectorId).then(d => ({
      binding: d.bindings.find(b => b.id === bindingId) ?? null
    })),
  })

  const { data: identitiesData } = useQuery({
    queryKey: ['connector-identities', connectorId, bindingId],
    queryFn: () => api.connectors.identities.list(connectorId, bindingId),
  })

  const updateBindingMutation = useMutation({
    mutationFn: (updates: Parameters<typeof api.connectors.bindings.update>[2]) =>
      api.connectors.bindings.update(connectorId, bindingId, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-binding', bindingId] }),
  })

  const updateIdentityMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.connectors.identities.update(connectorId, bindingId, id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-identities', connectorId, bindingId] }),
  })

  const binding = bindingData?.binding
  const identities = identitiesData?.identities ?? []

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (!binding) return <div className="p-6 text-sm text-destructive">Binding not found</div>

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" asChild>
          <Link href={base}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold">
            {binding.display_name ?? `Binding ${binding.id.slice(0, 8)}`}
          </h1>
          <p className="text-xs text-muted-foreground">Agent: {binding.agent_id.slice(0, 8)}</p>
        </div>
      </div>

      {/* Trigger settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Trigger Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Trigger Source</p>
              <Select
                value={binding.trigger_source}
                onValueChange={v => updateBindingMutation.mutate({ trigger_source: v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="message">Message</SelectItem>
                  <SelectItem value="event">Event</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Trigger Mode</p>
              <Select
                value={binding.trigger_mode}
                onValueChange={v => updateBindingMutation.mutate({ trigger_mode: v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="mention">Mention</SelectItem>
                  <SelectItem value="reply">Reply</SelectItem>
                  <SelectItem value="command">Command</SelectItem>
                  <SelectItem value="keyword">Keyword</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Adapter Type</p>
              <Select
                value={binding.adapter_type}
                onValueChange={v => updateBindingMutation.mutate({ adapter_type: v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conversation">Conversation</SelectItem>
                  <SelectItem value="task">Task</SelectItem>
                  <SelectItem value="notify">Notify</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Source Type</p>
              <Select
                value={binding.source_type}
                onValueChange={v => updateBindingMutation.mutate({ source_type: v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="group">Group</SelectItem>
                  <SelectItem value="channel">Channel</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium">Require Approval</p>
              <p className="text-xs text-muted-foreground">New identities must be approved</p>
            </div>
            <Switch
              checked={binding.require_approval}
              onCheckedChange={v => updateBindingMutation.mutate({ require_approval: v })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium">Include Sender Info</p>
              <p className="text-xs text-muted-foreground">Inject sender details into agent context</p>
            </div>
            <Switch
              checked={binding.include_sender_info}
              onCheckedChange={v => updateBindingMutation.mutate({ include_sender_info: v })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium">Enabled</p>
            </div>
            <Switch
              checked={binding.enabled}
              onCheckedChange={v => updateBindingMutation.mutate({ enabled: v })}
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Identities */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <User className="h-4 w-4" />
          Identities
          <Badge variant="secondary" className="ml-1">{identities.length}</Badge>
        </h2>

        {identities.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">No identities yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Identities appear when users interact through this binding.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {identities.map(identity => (
              <div key={identity.id} className="flex items-center justify-between py-2.5 px-4 rounded-lg border bg-card">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {identity.display_name ?? JSON.stringify(identity.external_ref_keys)}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">
                    {JSON.stringify(identity.external_ref_keys)}
                  </p>
                  {identity.last_seen_at && (
                    <p className="text-[10px] text-muted-foreground/60">
                      Last seen: {new Date(identity.last_seen_at).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <IdentityStatusBadge status={identity.status} />
                  {identity.status === 'pending' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] text-green-600 border-green-500/40"
                        onClick={() => updateIdentityMutation.mutate({ id: identity.id, status: 'approved' })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] text-destructive border-destructive/40"
                        onClick={() => updateIdentityMutation.mutate({ id: identity.id, status: 'blocked' })}
                      >
                        Block
                      </Button>
                    </>
                  )}
                  {identity.status === 'approved' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] text-destructive"
                      onClick={() => updateIdentityMutation.mutate({ id: identity.id, status: 'blocked' })}
                    >
                      Block
                    </Button>
                  )}
                  {identity.status === 'blocked' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] text-green-600"
                      onClick={() => updateIdentityMutation.mutate({ id: identity.id, status: 'approved' })}
                    >
                      Unblock
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
