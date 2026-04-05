'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectorBinding, ConnectorIdentity, ConnectorInviteCode, ConnectorItem } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from '@jiku/ui'
import { ArrowLeft, Ban, Check, Copy, Link2, Plus, Settings2, Trash2, UserCheck, Webhook, Users, Play, Square, X } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'

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
          <span>{binding.output_adapter}</span>
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

function InviteCodeRow({ invite, onRevoke, onDelete }: { invite: ConnectorInviteCode; onRevoke: () => void; onDelete: () => void }) {
  const isExpired = invite.expires_at ? new Date(invite.expires_at) < new Date() : false
  const isExhausted = invite.max_uses !== null && invite.use_count >= (invite.max_uses ?? 0)
  const isActive = !invite.revoked && !isExpired && !isExhausted
  return (
    <div className="flex items-center justify-between py-2.5 px-4 rounded-lg border bg-card group">
      <div className="space-y-0.5 min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono font-semibold tracking-widest">{invite.code}</code>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { navigator.clipboard.writeText(invite.code); toast.success('Code copied') }}>
            <Copy className="h-3 w-3" />
          </button>
          {invite.revoked && <Badge variant="secondary" className="text-[10px]">Revoked</Badge>}
          {isExpired && !invite.revoked && <Badge variant="secondary" className="text-[10px]">Expired</Badge>}
          {isExhausted && !invite.revoked && <Badge variant="secondary" className="text-[10px]">Exhausted</Badge>}
          {isActive && <Badge variant="outline" className="text-[10px] text-green-600 border-green-500/40">Active</Badge>}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {invite.label && <span>{invite.label}</span>}
          <span>Used {invite.use_count}{invite.max_uses ? `/${invite.max_uses}` : ''}</span>
          {invite.expires_at && <span>Expires {new Date(invite.expires_at).toLocaleDateString()}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {isActive && <Button size="sm" variant="ghost" className="h-7 text-xs text-amber-600" onClick={onRevoke}><Ban className="h-3 w-3 mr-1" />Revoke</Button>}
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={onDelete}><Trash2 className="h-3 w-3" /></Button>
      </div>
    </div>
  )
}

function GenerateCodeForm({ onGenerate }: { onGenerate: (body: { label?: string; max_uses?: number }) => void }) {
  const [label, setLabel] = useState('')
  const [maxUses, setMaxUses] = useState('')
  return (
    <div className="flex items-end gap-2 p-3 rounded-lg border bg-muted/30">
      <div className="space-y-1 flex-1">
        <Label className="text-xs">Label (optional)</Label>
        <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Team Alpha" className="h-7 text-xs" />
      </div>
      <div className="space-y-1 w-24">
        <Label className="text-xs">Max uses</Label>
        <Input type="number" value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="∞" className="h-7 text-xs" min={1} />
      </div>
      <Button size="sm" className="h-7 text-xs" onClick={() => { onGenerate({ label: label || undefined, max_uses: maxUses ? parseInt(maxUses) : undefined }); setLabel(''); setMaxUses('') }}>
        <Plus className="h-3 w-3 mr-1" />Generate
      </Button>
    </div>
  )
}

function AddBindingInline({
  agents,
  onCreate,
}: {
  agents: { id: string; name: string }[]
  onCreate: (opts: { agentId: string; adapter: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [adapter, setAdapter] = useState('conversation')
  const [agentId, setAgentId] = useState('')
  if (!agents.length) return null
  if (!open) {
    return (
      <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setOpen(true)}>
        <Plus className="h-3 w-3" />Add Binding
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Select value={adapter} onValueChange={setAdapter}>
        <SelectTrigger className="h-7 text-xs w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="conversation">Conversation</SelectItem>
          <SelectItem value="task">Task</SelectItem>
        </SelectContent>
      </Select>
      <Select value={agentId} onValueChange={setAgentId}>
        <SelectTrigger className="h-7 text-xs w-40"><SelectValue placeholder="Agent..." /></SelectTrigger>
        <SelectContent>
          {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" className="h-7 text-xs" disabled={!agentId} onClick={() => { onCreate({ agentId, adapter }); setOpen(false); setAgentId('') }}>
        Add
      </Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setOpen(false)}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}

function PairingRequestRow({
  identity,
  agents,
  onApprove,
  onReject,
}: {
  identity: ConnectorIdentity
  agents: { id: string; name: string }[]
  onApprove: (agentId: string, adapter: string) => void
  onReject: () => void
}) {
  const [selectedAgent, setSelectedAgent] = useState('')
  const [adapter, setAdapter] = useState('conversation')
  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg border bg-card gap-3">
      <div className="space-y-0.5 min-w-0">
        <p className="text-sm font-medium truncate">{identity.display_name ?? identity.external_ref_keys['username'] ?? identity.external_ref_keys['user_id']}</p>
        <p className="text-xs text-muted-foreground">{new Date(identity.created_at).toLocaleString()}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Select value={adapter} onValueChange={setAdapter}>
          <SelectTrigger className="h-7 text-xs w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="conversation">Conversation</SelectItem>
            <SelectItem value="task">Task</SelectItem>
          </SelectContent>
        </Select>
        <Select value={selectedAgent} onValueChange={setSelectedAgent}>
          <SelectTrigger className="h-7 text-xs w-40">
            <SelectValue placeholder="Select agent..." />
          </SelectTrigger>
          <SelectContent>
            {agents.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0 text-green-600 border-green-500/40"
          disabled={!selectedAgent}
          onClick={() => selectedAgent && onApprove(selectedAgent, adapter)}
        >
          <Check className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0 text-destructive border-destructive/40"
          onClick={onReject}
        >
          <X className="h-3 w-3" />
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
    mutationFn: ({ agentId, adapter }: { agentId: string; adapter: string }) => api.connectors.bindings.create(connectorId, {
      display_name: `Binding to ${agentsData?.agents.find(a => a.id === agentId)?.name ?? agentId}`,
      output_adapter: adapter,
      output_config: { agent_id: agentId },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] }),
  })

  const deleteBindingMutation = useMutation({
    mutationFn: (bindingId: string) => api.connectors.bindings.delete(connectorId, bindingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] }),
  })

  const { data: pairingData } = useQuery({
    queryKey: ['connector-pairing', connectorId],
    queryFn: () => api.connectors.pairingRequests.list(connectorId),
    refetchInterval: 10_000,
  })

  const approvePairingMutation = useMutation({
    mutationFn: ({ identityId, agentId, adapter }: { identityId: string; agentId: string; adapter: string }) =>
      api.connectors.pairingRequests.approve(connectorId, identityId, {
        output_adapter: adapter,
        output_config: { agent_id: agentId },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-pairing', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] })
    },
  })

  const rejectPairingMutation = useMutation({
    mutationFn: (identityId: string) => api.connectors.pairingRequests.reject(connectorId, identityId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-pairing', connectorId] }),
  })

  const { data: inviteCodesData } = useQuery({
    queryKey: ['connector-invite-codes', connectorId],
    queryFn: () => api.connectors.inviteCodes.list(connectorId),
  })

  const generateCodeMutation = useMutation({
    mutationFn: (body: { label?: string; max_uses?: number }) => api.connectors.inviteCodes.create(connectorId, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['connector-invite-codes', connectorId] })
      navigator.clipboard.writeText(data.invite_code.code).catch(() => {})
      toast.success(`Code ${data.invite_code.code} generated & copied`)
    },
  })

  const revokeCodeMutation = useMutation({
    mutationFn: (codeId: string) => api.connectors.inviteCodes.revoke(connectorId, codeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-invite-codes', connectorId] }),
  })

  const deleteCodeMutation = useMutation({
    mutationFn: (codeId: string) => api.connectors.inviteCodes.delete(connectorId, codeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-invite-codes', connectorId] }),
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
  const pairingRequests = pairingData?.pairing_requests ?? []
  const inviteCodes = inviteCodesData?.invite_codes ?? []

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

      {/* Pairing Requests */}
      {pairingRequests.length > 0 && (
        <>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium flex items-center gap-1.5">
                <UserCheck className="h-4 w-4" />
                Pairing Requests
              </h2>
              <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
                {pairingRequests.length} pending
              </Badge>
            </div>
            <div className="space-y-2">
              {pairingRequests.map(req => (
                <PairingRequestRow
                  key={req.id}
                  identity={req}
                  agents={agents}
                  onApprove={(agentId, adapter) => approvePairingMutation.mutate({ identityId: req.id, agentId, adapter })}
                  onReject={() => rejectPairingMutation.mutate(req.id)}
                />
              ))}
            </div>
          </div>
          <Separator />
        </>
      )}

      {/* Invite Codes */}
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Link2 className="h-4 w-4" />
            Invite Codes
            <Badge variant="secondary" className="ml-1">{inviteCodes.filter(c => !c.revoked).length} active</Badge>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Share a code — user sends <code className="bg-muted px-1 rounded">/start CODE</code> to get auto-approved.
          </p>
        </div>
        <GenerateCodeForm onGenerate={(body) => generateCodeMutation.mutate(body)} />
        {inviteCodes.length > 0 && (
          <div className="space-y-2">
            {inviteCodes.map(invite => (
              <InviteCodeRow
                key={invite.id}
                invite={invite}
                onRevoke={() => revokeCodeMutation.mutate(invite.id)}
                onDelete={() => deleteCodeMutation.mutate(invite.id)}
              />
            ))}
          </div>
        )}
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
          <AddBindingInline agents={agents} onCreate={({ agentId, adapter }) => createBindingMutation.mutate({ agentId, adapter })} />
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
