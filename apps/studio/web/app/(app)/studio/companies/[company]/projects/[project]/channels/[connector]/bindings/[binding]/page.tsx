'use client'

import { use } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectorIdentity, ConversationOutputConfig } from '@/lib/api'
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
import { Input } from '@jiku/ui'
import { ArrowLeft, CheckCircle2, XCircle, Clock, User, AlertCircle } from 'lucide-react'
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

  const convConfig = binding.output_config as unknown as ConversationOutputConfig

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" asChild>
          <Link href={base}><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold">
            {binding.display_name ?? `Binding ${binding.id.slice(0, 8)}`}
          </h1>
          <p className="text-xs text-muted-foreground">
            {binding.output_adapter}
            {convConfig?.agent_id ? ` · agent ${convConfig.agent_id.slice(0, 8)}` : ''}
          </p>
        </div>
        <Switch
          checked={binding.enabled}
          onCheckedChange={v => updateBindingMutation.mutate({ enabled: v })}
        />
      </div>

      {/* Source */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {binding.source_type === 'any' && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
              <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-[11px] text-amber-700 dark:text-amber-400">
                <strong>Source Type &ldquo;Any&rdquo;</strong> matches every chat on this connector — DMs, groups, and channels. Unintended users can trigger this binding. Prefer <code className="bg-amber-500/10 px-1 rounded">Private</code> (with a sender filter), <code className="bg-amber-500/10 px-1 rounded">Group</code>, or <code className="bg-amber-500/10 px-1 rounded">Channel</code> and use <em>Scope Filter</em> / <em>Source Ref Keys</em> to lock to a specific chat or user.
              </div>
            </div>
          )}
          {binding.source_ref_keys && Object.keys(binding.source_ref_keys).length > 0 && (
            <div className="rounded-md border bg-muted/20 p-2.5">
              <p className="text-[11px] font-medium text-muted-foreground mb-1">Locked to sender / chat</p>
              <pre className="text-[11px] font-mono">{JSON.stringify(binding.source_ref_keys, null, 2)}</pre>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Source Type</p>
              <Select value={binding.source_type} onValueChange={v => updateBindingMutation.mutate({ source_type: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private (DM) — single user</SelectItem>
                  <SelectItem value="group">Group — multi-user</SelectItem>
                  <SelectItem value="channel">Channel — broadcast</SelectItem>
                  <SelectItem value="any">Any (legacy, unsafe)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Trigger Source</p>
              <Select value={binding.trigger_source} onValueChange={v => updateBindingMutation.mutate({ trigger_source: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="message">Message</SelectItem>
                  <SelectItem value="event">Event</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Trigger Mode</p>
              <Select value={binding.trigger_mode} onValueChange={v => updateBindingMutation.mutate({ trigger_mode: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="mention">Mention</SelectItem>
                  <SelectItem value="reply">Reply</SelectItem>
                  <SelectItem value="command">Command</SelectItem>
                  <SelectItem value="keyword">Keyword</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(binding.source_type === 'group' || binding.source_type === 'channel' || binding.source_type === 'any') && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Member Mode</p>
                <p className="text-[10px] text-muted-foreground">How new members in the scope are admitted.</p>
                <Select
                  value={binding.member_mode ?? 'require_approval'}
                  onValueChange={v => updateBindingMutation.mutate({ member_mode: v as 'require_approval' | 'allow_all' })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="require_approval">Require approval (safer)</SelectItem>
                    <SelectItem value="allow_all">Allow all members</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Scope Lock — friendly per-source-type picker */}
      {(binding.source_type === 'group' || binding.source_type === 'channel' || binding.source_type === 'private') && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Scope Lock</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(binding.source_type === 'group' || binding.source_type === 'channel') && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Chat ID (lock to one specific {binding.source_type})</p>
                <p className="text-[10px] text-muted-foreground">
                  Paste the platform chat_id (e.g. Telegram <code className="bg-muted px-1 rounded">-1003890986702</code>). Leave empty to match any {binding.source_type}. Saving updates both <code className="bg-muted px-1 rounded">scope_key_pattern</code> and <code className="bg-muted px-1 rounded">source_ref_keys.chat_id</code>.
                </p>
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="-1001234567890"
                  defaultValue={
                    (binding.source_ref_keys as Record<string, string> | null | undefined)?.['chat_id']
                    ?? (binding.scope_key_pattern?.startsWith('group:') && !binding.scope_key_pattern.includes('*')
                      ? binding.scope_key_pattern.split(':')[1]
                      : '')
                    ?? ''
                  }
                  onBlur={e => {
                    const raw = e.target.value.trim()
                    const existingRef = (binding.source_ref_keys as Record<string, string> | null | undefined) ?? {}
                    if (!raw) {
                      const { chat_id: _removed, ...rest } = existingRef
                      void _removed
                      updateBindingMutation.mutate({
                        scope_key_pattern: null,
                        source_ref_keys: Object.keys(rest).length ? rest : null,
                      })
                    } else {
                      updateBindingMutation.mutate({
                        scope_key_pattern: `group:${raw}`,
                        source_ref_keys: { ...existingRef, chat_id: raw },
                      })
                    }
                  }}
                />
              </div>
            )}
            {binding.source_type === 'private' && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Sender User ID (lock to one user's DM)</p>
                <p className="text-[10px] text-muted-foreground">
                  External user_id from the platform (e.g. Telegram numeric id). Pairing approval sets this automatically — edit only if you need to re-scope.
                </p>
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="1309769651"
                  defaultValue={(binding.source_ref_keys as Record<string, string> | null | undefined)?.['user_id'] ?? ''}
                  onBlur={e => {
                    const raw = e.target.value.trim()
                    const existingRef = (binding.source_ref_keys as Record<string, string> | null | undefined) ?? {}
                    if (!raw) {
                      const { user_id: _removed, ...rest } = existingRef
                      void _removed
                      updateBindingMutation.mutate({
                        source_ref_keys: Object.keys(rest).length ? rest : null,
                      })
                    } else {
                      updateBindingMutation.mutate({
                        source_ref_keys: { ...existingRef, user_id: raw },
                      })
                    }
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Routing (Plan 15.5) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Routing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Priority</p>
              <p className="text-[10px] text-muted-foreground">Higher number = higher priority. Default 0.</p>
              <Input
                type="number"
                className="h-8 text-xs w-24"
                value={binding.priority ?? 0}
                onChange={e => updateBindingMutation.mutate({ priority: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Trigger Regex</p>
              <p className="text-[10px] text-muted-foreground">Optional regex matched against message text.</p>
              <Input
                className="h-8 text-xs"
                value={binding.trigger_regex ?? ''}
                placeholder="e.g. ^(help|support).*"
                onChange={e => updateBindingMutation.mutate({ trigger_regex: e.target.value || null })}
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Scope Filter (Plan 22)</p>
              <p className="text-[10px] text-muted-foreground">
                Restrict to a conversation scope: <code className="bg-muted px-1 rounded">group:*</code> (all groups),{' '}
                <code className="bg-muted px-1 rounded">dm:*</code> (DMs only),{' '}
                <code className="bg-muted px-1 rounded">group:-1001234</code> (specific group),{' '}
                <code className="bg-muted px-1 rounded">group:-1001234:topic:42</code> (forum topic). Empty = match all.
              </p>
              <Input
                className="h-8 text-xs"
                value={binding.scope_key_pattern ?? ''}
                placeholder="e.g. group:*"
                onChange={e => updateBindingMutation.mutate({ scope_key_pattern: e.target.value || null })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Destination */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Destination</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Output Adapter</p>
              <Select value={binding.output_adapter} onValueChange={v => updateBindingMutation.mutate({ output_adapter: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="conversation">Conversation</SelectItem>
                  <SelectItem value="task">Task</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {binding.output_adapter === 'conversation' && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Conversation Mode</p>
                <Select
                  value={convConfig?.conversation_mode ?? 'persistent'}
                  onValueChange={v => updateBindingMutation.mutate({
                    output_config: { ...binding.output_config, conversation_mode: v }
                  })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="persistent">Persistent (1 session per user)</SelectItem>
                    <SelectItem value="new">New (new session each message)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium">Include Sender Info</p>
              <p className="text-xs text-muted-foreground">Inject sender details into agent context</p>
            </div>
            <Switch checked={binding.include_sender_info} onCheckedChange={v => updateBindingMutation.mutate({ include_sender_info: v })} />
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
                  {identity.status === 'approved' && (
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] text-destructive"
                      onClick={() => updateIdentityMutation.mutate({ id: identity.id, status: 'blocked' })}>
                      Block
                    </Button>
                  )}
                  {identity.status === 'blocked' && (
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] text-green-600"
                      onClick={() => updateIdentityMutation.mutate({ id: identity.id, status: 'approved' })}>
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
