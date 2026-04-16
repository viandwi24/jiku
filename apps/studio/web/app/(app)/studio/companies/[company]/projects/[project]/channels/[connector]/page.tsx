'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectorBinding, ConnectorIdentity, ConnectorInviteCode, ConnectorItem, ConnectorTargetItem } from '@/lib/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@jiku/ui'
import { ArrowLeft, Ban, Bot, Check, Clock, Copy, Link2, Pencil, Plus, RefreshCw, Send, Settings2, Target, Terminal, Trash2, UserCheck, Webhook, Users, Play, Square, X, XCircle } from 'lucide-react'
import { ConsolePanel } from '@/components/console/console-panel'
import Link from 'next/link'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; connector: string }>
}

/**
 * Small liveness indicator for the adapter's polling loop. Flags "no events
 * in >5 min" as a warning — useful signal that the bot might be stuck even
 * when status='active'. User's escape hatch is the Restart button.
 */
function HealthBadge({ adapter }: {
  adapter: { polling: boolean; last_event_at: string | null; bot_user_id: number | null }
}) {
  const lastMs = adapter.last_event_at ? new Date(adapter.last_event_at).getTime() : null
  const ageSec = lastMs ? Math.floor((Date.now() - lastMs) / 1000) : null
  const stale = ageSec !== null && ageSec > 300
  const never = lastMs === null
  const color = !adapter.polling
    ? 'text-destructive border-destructive/40'
    : stale
      ? 'text-amber-600 border-amber-500/40'
      : 'text-green-600 border-green-500/40'
  const label = !adapter.polling
    ? 'polling offline'
    : never
      ? 'polling aktif · belum ada event'
      : stale
        ? `polling aktif · last event ${formatAge(ageSec!)} lalu (stale)`
        : `polling aktif · last event ${formatAge(ageSec!)} lalu`
  return (
    <div className="flex items-center gap-2 text-xs">
      <Badge variant="outline" className={color}>{label}</Badge>
    </div>
  )
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

/**
 * "Running as" identity badge — shows which bot/user account the adapter is
 * actually authenticated as. Static per active connector, but we refetch every
 * 30s since it can change after a re-activate (e.g. different credential).
 */
function IdentityBadge({
  identity,
  credential,
  reason,
}: {
  identity: { name: string; username?: string | null; user_id?: string | null; metadata?: Record<string, unknown> } | null
  credential: { id: string; name: string; adapter_id: string } | null
  reason?: string
}) {
  // Adapter doesn't support identity introspection — hide entirely.
  if (reason === 'adapter_not_identity_capable') return null

  if (!identity) {
    if (reason === 'connector_not_active') {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bot className="h-3 w-3" />
          <span>(not active — start to see identity)</span>
        </div>
      )
    }
    return null
  }

  const label = identity.username
    ? `Running as ${identity.username.startsWith('@') ? identity.username : `@${identity.username}`}`
    : `Running as ${identity.name}`

  const kind = typeof identity.metadata?.['kind'] === 'string' ? (identity.metadata['kind'] as string) : null
  const isPremium = identity.metadata?.['is_premium']

  return (
    <TooltipProvider>
      <div className="inline-flex flex-col gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-xs font-medium w-fit">
              <Bot className="h-3 w-3 text-muted-foreground" />
              <span>Running as </span>
              <span className="font-mono">
                {identity.username
                  ? (identity.username.startsWith('@') ? identity.username : `@${identity.username}`)
                  : identity.name}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <div className="space-y-0.5">
              <div>{label}</div>
              {identity.user_id && (
                <div className="text-muted-foreground">
                  user_id: <span className="font-mono">{identity.user_id}</span>
                </div>
              )}
              {kind && (
                <div className="text-muted-foreground">
                  kind: <span className="font-mono">{kind}</span>
                </div>
              )}
              {typeof isPremium === 'boolean' && (
                <div className="text-muted-foreground">
                  is_premium: <span className="font-mono">{String(isPremium)}</span>
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
        {credential ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="inline-flex items-center gap-1 pl-2 text-[11px] text-muted-foreground w-fit cursor-help">
                <span>Credential:</span>
                <span className="font-mono">{credential.name}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              <div className="space-y-0.5">
                <div>
                  credential_id: <span className="font-mono">{credential.id}</span>
                </div>
                <div className="text-muted-foreground">
                  adapter: <span className="font-mono">{credential.adapter_id}</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <div className="inline-flex items-center gap-1 pl-2 text-[11px] text-muted-foreground w-fit italic">
            Credential: (unknown)
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

function BindingCard({
  binding,
  base,
  onDelete,
  onSave,
}: {
  binding: ConnectorBinding
  base: string
  onDelete: () => void
  onSave: (updates: { display_name?: string | null; member_mode?: 'require_approval' | 'allow_all' }) => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [displayName, setDisplayName] = useState(binding.display_name ?? '')
  const [memberMode, setMemberMode] = useState<'require_approval' | 'allow_all'>(binding.member_mode ?? 'require_approval')

  const openEdit = () => {
    setDisplayName(binding.display_name ?? '')
    setMemberMode(binding.member_mode ?? 'require_approval')
    setEditOpen(true)
  }

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
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={openEdit}
          title="Edit binding"
        >
          <Pencil className="h-3 w-3" />
        </Button>
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit binding</DialogTitle>
            <DialogDescription>Update display name and member admission mode. For deeper config use Detail.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor={`binding-name-${binding.id}`}>Display name</Label>
              <Input
                id={`binding-name-${binding.id}`}
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={`Binding ${binding.id.slice(0, 8)}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Member mode</Label>
              <RadioGroup value={memberMode} onValueChange={v => setMemberMode(v as 'require_approval' | 'allow_all')}>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="require_approval" id={`mm-req-${binding.id}`} />
                  <Label htmlFor={`mm-req-${binding.id}`} className="font-normal">Require approval (new members wait for admin)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="allow_all" id={`mm-all-${binding.id}`} />
                  <Label htmlFor={`mm-all-${binding.id}`} className="font-normal">Allow all (auto-approve new members)</Label>
                </div>
              </RadioGroup>
              <p className="text-[11px] text-muted-foreground">Ignored for DM bindings.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => {
                const trimmed = displayName.trim()
                onSave({
                  display_name: trimmed === '' ? null : trimmed,
                  member_mode: memberMode,
                })
                setEditOpen(false)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TargetRow({
  target,
  onDelete,
  onSave,
}: {
  target: ConnectorTargetItem
  onDelete: () => void
  onSave: (updates: { name?: string; display_name?: string | null; description?: string | null }) => void
}) {
  const chatId = (target.ref_keys as Record<string, string>)?.['chat_id'] ?? ''
  const [editOpen, setEditOpen] = useState(false)
  const [name, setName] = useState(target.name)
  const [displayName, setDisplayName] = useState(target.display_name ?? '')
  const [description, setDescription] = useState(target.description ?? '')

  const openEdit = () => {
    setName(target.name)
    setDisplayName(target.display_name ?? '')
    setDescription(target.description ?? '')
    setEditOpen(true)
  }

  const canSave = name.trim().length > 0

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg border bg-card group">
      <div className="space-y-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono font-semibold">{target.name}</code>
          {target.display_name && <span className="text-xs text-muted-foreground truncate">· {target.display_name}</span>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>chat_id: <code className="bg-muted px-1 rounded">{chatId}</code></span>
          {target.scope_key && <span>scope: <code className="bg-muted px-1 rounded">{target.scope_key}</code></span>}
          {target.description && <span className="truncate">· {target.description}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={openEdit}
          title="Edit target"
        >
          <Pencil className="h-3 w-3" />
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit target</DialogTitle>
            <DialogDescription>Rename this target or update its display name and description. ref_keys and scope are immutable here.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor={`target-name-${target.id}`}>Name (slug)</Label>
              <Input
                id={`target-name-${target.id}`}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="morning-briefing"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`target-dname-${target.id}`}>Display name</Label>
              <Input
                id={`target-dname-${target.id}`}
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Morning briefing channel"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`target-desc-${target.id}`}>Description</Label>
              <Textarea
                id={`target-desc-${target.id}`}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Optional description"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() => {
                const updates: { name?: string; display_name?: string | null; description?: string | null } = {}
                const trimmedName = name.trim()
                if (trimmedName !== target.name) updates.name = trimmedName
                const trimmedDname = displayName.trim()
                const currentDname = target.display_name ?? ''
                if (trimmedDname !== currentDname) updates.display_name = trimmedDname === '' ? null : trimmedDname
                const trimmedDesc = description.trim()
                const currentDesc = target.description ?? ''
                if (trimmedDesc !== currentDesc) updates.description = trimmedDesc === '' ? null : trimmedDesc
                onSave(updates)
                setEditOpen(false)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AddTargetForm({ onCreate }: { onCreate: (body: {
  name: string; display_name?: string; description?: string
  ref_keys: Record<string, string>; scope_key?: string
}) => void }) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [chatId, setChatId] = useState('')
  const [threadId, setThreadId] = useState('')
  const [scopeKey, setScopeKey] = useState('')
  const [description, setDescription] = useState('')

  const canSubmit = name.trim() && chatId.trim()

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="name (slug, e.g. morning-briefing)" value={name} onChange={e => setName(e.target.value)} className="h-8 text-xs" />
        <Input placeholder="display name (optional)" value={displayName} onChange={e => setDisplayName(e.target.value)} className="h-8 text-xs" />
        <Input placeholder="chat_id (required)" value={chatId} onChange={e => setChatId(e.target.value)} className="h-8 text-xs" />
        <Input placeholder="thread_id (optional, for topics)" value={threadId} onChange={e => setThreadId(e.target.value)} className="h-8 text-xs" />
        <Input placeholder="scope_key (optional)" value={scopeKey} onChange={e => setScopeKey(e.target.value)} className="h-8 text-xs col-span-2" />
        <Input placeholder="description (optional)" value={description} onChange={e => setDescription(e.target.value)} className="h-8 text-xs col-span-2" />
      </div>
      <Button
        size="sm"
        disabled={!canSubmit}
        onClick={() => {
          const ref_keys: Record<string, string> = { chat_id: chatId.trim() }
          if (threadId.trim()) ref_keys['thread_id'] = threadId.trim()
          onCreate({
            name: name.trim(),
            display_name: displayName.trim() || undefined,
            description: description.trim() || undefined,
            ref_keys,
            scope_key: scopeKey.trim() || undefined,
          })
          setName(''); setDisplayName(''); setChatId(''); setThreadId(''); setScopeKey(''); setDescription('')
        }}
        className="h-7 text-xs"
      >
        <Plus className="h-3 w-3 mr-1" />
        Add target
      </Button>
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

function GroupPairingRow({
  binding,
  agents,
  onApprove,
  onReject,
}: {
  binding: ConnectorBinding
  agents: { id: string; name: string }[]
  onApprove: (agentId: string, memberMode: 'require_approval' | 'allow_all') => void
  onReject: () => void
}) {
  const [selectedAgent, setSelectedAgent] = useState('')
  const [memberMode, setMemberMode] = useState<'require_approval' | 'allow_all'>('require_approval')
  const rawTitle = binding.display_name?.replace(/^Pending group pairing:\s*/, '') ?? binding.scope_key_pattern ?? binding.id
  // Split chat and topic parts for nicer rendering: "Chat → Topic"
  const [chatPart, ...topicRest] = rawTitle.split(' → ')
  const topicPart = topicRest.join(' → ') || null
  const sourceRefKeys = (binding.source_ref_keys ?? {}) as Record<string, string>
  const threadId = sourceRefKeys['thread_id'] ?? (binding.scope_key_pattern?.match(/:topic:(\d+)/)?.[1])
  return (
    <div className="flex items-start justify-between py-3 px-4 rounded-lg border bg-card gap-3">
      <div className="space-y-1 min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium truncate">{chatPart}</p>
          {topicPart && (
            <Badge variant="outline" className="text-[10px] font-normal bg-violet-500/10 text-violet-600 border-violet-500/30">
              topic: {topicPart}
              {threadId && <span className="ml-1 opacity-60 font-mono">#{threadId}</span>}
            </Badge>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground font-mono truncate">{binding.scope_key_pattern}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Select value={memberMode} onValueChange={v => setMemberMode(v as 'require_approval' | 'allow_all')}>
          <SelectTrigger className="h-7 text-xs w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="require_approval">Require approval</SelectItem>
            <SelectItem value="allow_all">Allow all members</SelectItem>
          </SelectContent>
        </Select>
        <Select value={selectedAgent} onValueChange={setSelectedAgent}>
          <SelectTrigger className="h-7 text-xs w-40"><SelectValue placeholder="Select agent..." /></SelectTrigger>
          <SelectContent>
            {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          size="sm" variant="outline"
          className="h-7 w-7 p-0 text-green-600 border-green-500/40"
          disabled={!selectedAgent}
          onClick={() => selectedAgent && onApprove(selectedAgent, memberMode)}
        >
          <Check className="h-3 w-3" />
        </Button>
        <Button
          size="sm" variant="outline"
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

  const updateBindingMutation = useMutation({
    mutationFn: ({ bindingId, updates }: { bindingId: string; updates: Partial<ConnectorBinding> }) =>
      api.connectors.bindings.update(connectorId, bindingId, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] })
      toast.success('Binding updated')
    },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
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

  const { data: groupPairingData } = useQuery({
    queryKey: ['connector-group-pairing', connectorId],
    queryFn: () => api.connectors.groupPairings.list(connectorId),
    refetchInterval: 10_000,
  })

  const approveGroupPairingMutation = useMutation({
    mutationFn: ({ bindingId, agentId, memberMode }: { bindingId: string; agentId: string; memberMode: 'require_approval' | 'allow_all' }) =>
      api.connectors.groupPairings.approve(connectorId, bindingId, {
        agent_id: agentId,
        member_mode: memberMode,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-group-pairing', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-bindings', connectorId] })
    },
  })

  const rejectGroupPairingMutation = useMutation({
    mutationFn: (bindingId: string) => api.connectors.groupPairings.reject(connectorId, bindingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-group-pairing', connectorId] }),
  })

  const { data: blockedData } = useQuery({
    queryKey: ['connector-blocked', connectorId],
    queryFn: () => api.connectors.blockedIdentities.list(connectorId),
    refetchInterval: 30_000,
  })

  const unblockIdentityMutation = useMutation({
    mutationFn: (identityId: string) => api.connectors.blockedIdentities.unblock(connectorId, identityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-blocked', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-pairing', connectorId] })
    },
  })

  const deleteIdentityMutation = useMutation({
    mutationFn: (identityId: string) => api.connectors.blockedIdentities.delete(connectorId, identityId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-blocked', connectorId] }),
  })

  // Pairing & Identity History (debug panel) — ALL identities regardless of status.
  const { data: allIdentitiesData, refetch: refetchAllIdentities, isFetching: allIdentitiesFetching } = useQuery({
    queryKey: ['connector-identities', connectorId],
    queryFn: () => api.connectors.listAllIdentities(connectorId),
    refetchInterval: 30_000,
  })

  const resetIdentityMutation = useMutation({
    mutationFn: (identityId: string) => api.connectors.resetIdentity(connectorId, identityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-identities', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-pairing', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-blocked', connectorId] })
      toast.success('Identity reset to pending')
    },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
  })

  const forceDeleteIdentityMutation = useMutation({
    mutationFn: (identityId: string) => api.connectors.forceDeleteIdentity(connectorId, identityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-identities', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-pairing', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-blocked', connectorId] })
      toast.success('Identity deleted')
    },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
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

  // Plan 22 — Channel Targets
  const { data: targetsData } = useQuery({
    queryKey: ['connector-targets', connectorId],
    queryFn: () => api.connectors.targets.list(connectorId),
  })

  const createTargetMutation = useMutation({
    mutationFn: (body: {
      name: string; display_name?: string; description?: string
      ref_keys: Record<string, string>; scope_key?: string
    }) => api.connectors.targets.create(connectorId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-targets', connectorId] })
      toast.success('Target created')
    },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
  })

  const deleteTargetMutation = useMutation({
    mutationFn: (targetId: string) => api.connectors.targets.delete(connectorId, targetId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-targets', connectorId] }),
  })

  const updateTargetMutation = useMutation({
    mutationFn: ({ targetId, updates }: { targetId: string; updates: Record<string, unknown> }) =>
      api.connectors.targets.update(connectorId, targetId, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-targets', connectorId] })
      toast.success('Target updated')
    },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
  })

  const activateMutation = useMutation({
    mutationFn: () => api.connectors.activate(connectorId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector', connectorId] }),
  })

  const deactivateMutation = useMutation({
    mutationFn: () => api.connectors.deactivate(connectorId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector', connectorId] }),
  })

  const restartMutation = useMutation({
    mutationFn: () => api.connectors.restart(connectorId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector', connectorId] })
      qc.invalidateQueries({ queryKey: ['connector-health', connectorId] })
    },
  })

  // Health poll — only while the connector is supposed to be active. 15s is
  // a balance between detecting a stalled polling loop quickly and not
  // spamming the DB.
  const { data: healthData } = useQuery({
    queryKey: ['connector-health', connectorId],
    queryFn: () => api.connectors.health(connectorId),
    enabled: connectorData?.connector.status === 'active',
    refetchInterval: 15_000,
  })

  // Identity poll — effectively static while the connector is active, but
  // refetch every 30s so a re-activate with a different credential shows up
  // without a full page reload.
  const { data: identityData } = useQuery({
    queryKey: ['connector-identity', connectorId],
    queryFn: () => api.connectors.getIdentity(connectorId),
    refetchInterval: 30_000,
  })

  const connector = connectorData?.connector
  const agents = agentsData?.agents ?? []
  const pairingRequests = pairingData?.pairing_requests ?? []
  const groupPairings = groupPairingData?.group_pairings ?? []
  const blockedIdentities = blockedData?.identities ?? []
  // Exclude draft group-pairing bindings from the main list — they live in the
  // Group Pairing Requests section above. Heuristic: enabled=false AND no agent_id.
  const draftIds = new Set(groupPairings.map(b => b.id))
  const bindings = (bindingsData?.bindings ?? []).filter(b => !draftIds.has(b.id))
  const inviteCodes = inviteCodesData?.invite_codes ?? []
  const targets = targetsData?.targets ?? []
  const allIdentities = allIdentitiesData?.identities ?? []

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
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              title="Stop then re-start the connector. Use this if the adapter appears stuck (no inbound events for several minutes)."
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
            >
              <RefreshCw className={`h-3 w-3 ${restartMutation.isPending ? 'animate-spin' : ''}`} />
              {restartMutation.isPending ? 'Restarting...' : 'Restart'}
            </Button>
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
          </>
        )}
      </div>
      {/* Health + identity indicators — only meaningful when the adapter reports runtime state. */}
      {(connector.status === 'active' || identityData) && (
        <div className="flex flex-wrap items-center gap-3">
          {connector.status === 'active' && healthData?.adapter && (
            <HealthBadge adapter={healthData.adapter} />
          )}
          {identityData && (
            <IdentityBadge identity={identityData.identity} credential={identityData.credential} reason={identityData.reason} />
          )}
        </div>
      )}
      {connector.error_message && (
        <p className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded px-3 py-2">
          {connector.error_message}
        </p>
      )}

      {/* Quick nav — jump to project channels page with this connector pre-filtered */}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
          <Link href={`/studio/companies/${companySlug}/projects/${projectSlug}/channels?tab=events&connector_id=${connectorId}`}>
            Events
          </Link>
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
          <Link href={`/studio/companies/${companySlug}/projects/${projectSlug}/channels?tab=messages&connector_id=${connectorId}`}>
            Messages
          </Link>
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
                DM Pairing Requests
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

      {/* Pairing & Identity History (debug panel) */}
      <>
        <IdentityHistorySection
          identities={allIdentities}
          isFetching={allIdentitiesFetching}
          onRefresh={() => refetchAllIdentities()}
          onReset={(identityId) => resetIdentityMutation.mutate(identityId)}
          onForceDelete={(identityId) => forceDeleteIdentityMutation.mutate(identityId)}
          resetPending={resetIdentityMutation.isPending}
          deletePending={forceDeleteIdentityMutation.isPending}
        />
        <Separator />
      </>

      {/* Blocked / Rejected identities — cleanup workspace */}
      {blockedIdentities.length > 0 && (
        <>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium flex items-center gap-1.5">
                <XCircle className="h-4 w-4" />
                Blocked Identities
              </h2>
              <Badge variant="secondary" className="bg-rose-500/10 text-rose-600 border-rose-500/20">
                {blockedIdentities.length}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Users whose pairing was rejected (or stuck rows). Unblock to send back to the pending queue, or delete to remove them entirely. Deleting means the user must DM the bot again to re-appear as a pairing request.
            </p>
            <div className="space-y-2">
              {blockedIdentities.map(id => (
                <div key={id.id} className="flex items-center justify-between py-2.5 px-4 rounded-lg border bg-card gap-3">
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {id.display_name ?? id.external_ref_keys?.['username'] ?? id.external_ref_keys?.['user_id'] ?? id.id}
                    </p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate">
                      user_id={id.external_ref_keys?.['user_id']} · blocked since {new Date(id.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-xs gap-1"
                      onClick={() => unblockIdentityMutation.mutate(id.id)}
                      disabled={unblockIdentityMutation.isPending}
                    >
                      <Clock className="h-3 w-3" /> Unblock
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      className="h-7 w-7 p-0 text-destructive border-destructive/40"
                      onClick={() => { if (confirm('Hard-delete this identity row?')) deleteIdentityMutation.mutate(id.id) }}
                      disabled={deleteIdentityMutation.isPending}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Separator />
        </>
      )}

      {/* Group Pairing Drafts — bot was added to a group, admin must assign an agent */}
      {groupPairings.length > 0 && (
        <>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium flex items-center gap-1.5">
                <UserCheck className="h-4 w-4" />
                Group Pairing Requests
              </h2>
              <Badge variant="secondary" className="bg-sky-500/10 text-sky-600 border-sky-500/20">
                {groupPairings.length} pending
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              The bot was added to these groups. Pick an agent + member mode to turn each draft into an active group binding.
            </p>
            <div className="space-y-2">
              {groupPairings.map(b => (
                <GroupPairingRow
                  key={b.id}
                  binding={b}
                  agents={agents}
                  onApprove={(agentId, memberMode) => approveGroupPairingMutation.mutate({ bindingId: b.id, agentId, memberMode })}
                  onReject={() => rejectGroupPairingMutation.mutate(b.id)}
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

      {/* Plan 22 — Channel Targets */}
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Target className="h-4 w-4" />
            Channel Targets
            <Badge variant="secondary" className="ml-1">{targets.length}</Badge>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Named outbound destinations. Agents can send via <code className="bg-muted px-1 rounded">connector_send_to_target(&quot;name&quot;, message)</code> in prompts.
          </p>
        </div>
        <AddTargetForm onCreate={(body) => createTargetMutation.mutate(body)} />
        {targets.length > 0 && (
          <div className="space-y-2">
            {targets.map(t => (
              <TargetRow
                key={t.id}
                target={t}
                onDelete={() => { if (confirm(`Delete target "${t.name}"?`)) deleteTargetMutation.mutate(t.id) }}
                onSave={(updates) => {
                  if (Object.keys(updates).length === 0) return
                  updateTargetMutation.mutate({ targetId: t.id, updates })
                }}
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
                onSave={(updates) => updateBindingMutation.mutate({ bindingId: binding.id, updates })}
              />
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Console — live log stream for this connector instance (session-scoped) */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Terminal className="h-4 w-4" /> Console
        </h2>
        <ConsolePanel
          consoleId={`${connector.plugin_id}:connector:${connector.id}`}
          title={connector.display_name}
          height={360}
          variant="terminal"
        />
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

      <OutboundApprovalSection connector={connector} onChanged={() => qc.invalidateQueries({ queryKey: ['connector', connectorId] })} />
      <TrafficModeSection connector={connector} onChanged={() => qc.invalidateQueries({ queryKey: ['connector', connectorId] })} />
      <LogModeSection connector={connector} onChanged={() => qc.invalidateQueries({ queryKey: ['connector', connectorId] })} />
    </div>
  )
}

function TrafficModeSection({
  connector, onChanged,
}: {
  connector: ConnectorItem
  onChanged: () => void
}) {
  const initial = (connector.traffic_mode ?? 'both') as 'inbound_only' | 'outbound_only' | 'both'
  const [mode, setMode] = useState<'inbound_only' | 'outbound_only' | 'both'>(initial)
  const dirty = mode !== initial

  const save = useMutation({
    mutationFn: () => api.connectors.update(connector.id, { traffic_mode: mode }),
    onSuccess: () => { toast.success('Traffic mode updated'); onChanged() },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
  })

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Traffic Mode</h2>
        <p className="text-xs text-muted-foreground">
          Scope the connector to a single direction based on your strategy. Polling/lifecycle is unaffected — this gates only what the routing pipeline + outbound tools are allowed to do.
        </p>
      </div>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Direction</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'inbound_only' | 'outbound_only' | 'both')}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="both">Both — inbound routing + outbound sends (default)</SelectItem>
                <SelectItem value="inbound_only">Inbound only — listen, do not reply (archive / monitor strategy)</SelectItem>
                <SelectItem value="outbound_only">Outbound only — broadcast / notifier; ignore inbound</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {mode === 'both'
                ? 'Default: inbound events route to bindings/agents, outbound sends + actions allowed.'
                : mode === 'inbound_only'
                  ? 'Inbound events are routed and logged, but the agent reply path is skipped and any connector_send / connector_run_action call returns code TRAFFIC_INBOUND_ONLY. Useful for archive / monitoring strategies.'
                  : 'Inbound events are finalised as dropped (drop_reason: traffic_outbound_only) and never reach a binding. The connector remains usable for outbound notifications / broadcasts.'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setMode(initial)}>
                Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function LogModeSection({
  connector, onChanged,
}: {
  connector: ConnectorItem
  onChanged: () => void
}) {
  const initial = (connector.log_mode ?? 'all') as 'all' | 'active_binding_only'
  const [mode, setMode] = useState<'all' | 'active_binding_only'>(initial)
  const dirty = mode !== initial

  const save = useMutation({
    mutationFn: () => api.connectors.update(connector.id, { log_mode: mode }),
    onSuccess: () => { toast.success('Log mode updated'); onChanged() },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
  })

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Inbound Log Mode</h2>
        <p className="text-xs text-muted-foreground">
          Control which inbound events and messages appear in the Events / Messages tabs.
        </p>
      </div>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'all' | 'active_binding_only')}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All — log every inbound (default)</SelectItem>
                <SelectItem value="active_binding_only">Active binding only — skip chats with no binding/target</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {mode === 'all'
                ? 'Bot logs every message from every chat it\'s in — including unrelated groups.'
                : 'Bot only logs events from chats that already have a matching binding or registered target. Business logic (pairing drafts, identity creation) still runs — only the log row is skipped.'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setMode(initial)}>
                Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Plan 25 — Outbound approval gate ─────────────────────────────────────────
function OutboundApprovalSection({
  connector, onChanged,
}: {
  connector: ConnectorItem
  onChanged: () => void
}) {
  const initialMode = connector.outbound_approval?.mode ?? 'none'
  const initialExpiry = connector.outbound_approval?.default_expires_in_seconds ?? 3600
  const [mode, setMode] = useState<'none' | 'always' | 'tagged'>(initialMode)
  const [expiry, setExpiry] = useState<number>(initialExpiry)

  const dirty = mode !== initialMode || expiry !== initialExpiry

  const save = useMutation({
    mutationFn: () => api.connectors.update(connector.id, {
      outbound_approval: { mode, default_expires_in_seconds: expiry },
    }),
    onSuccess: () => { toast.success('Outbound approval updated'); onChanged() },
    onError: (err: Error) => toast.error(String(err.message ?? err)),
  })

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Outbound Approval</h2>
        <p className="text-xs text-muted-foreground">
          Hold outbound messages from this connector in the Action Center until an operator approves them.
        </p>
      </div>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'none' | 'always' | 'tagged')}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None — send immediately (default)</SelectItem>
                <SelectItem value="always">Always — every outbound message needs approval</SelectItem>
                <SelectItem value="tagged">Tagged — only when agent sets params.require_approval = true</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode !== 'none' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Default expiry (seconds)</Label>
              <Input
                type="number"
                value={expiry}
                onChange={(e) => setExpiry(Math.max(60, Number(e.target.value) || 0))}
                min={60}
                max={604800}
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">Pending requests auto-expire after this many seconds. Min 60, max 604800 (7 days).</p>
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => { setMode(initialMode); setExpiry(initialExpiry) }}>
                Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Pairing & Identity History ────────────────────────────────────────────
interface IdentityHistoryRow {
  id: string
  connector_id: string
  binding_id: string | null
  external_ref_keys: Record<string, string> | null
  display_name: string | null
  status: 'pending' | 'approved' | 'blocked'
  created_at: string
  approved_at: string | null
  last_seen_at: string | null
}

function IdentityHistorySection({
  identities,
  isFetching,
  onRefresh,
  onReset,
  onForceDelete,
  resetPending,
  deletePending,
}: {
  identities: IdentityHistoryRow[]
  isFetching: boolean
  onRefresh: () => void
  onReset: (identityId: string) => void
  onForceDelete: (identityId: string) => void
  resetPending: boolean
  deletePending: boolean
}) {
  const [confirmReset, setConfirmReset] = useState<IdentityHistoryRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<IdentityHistoryRow | null>(null)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Users className="h-4 w-4" />
            Pairing &amp; Identity History
            <Badge variant="secondary" className="ml-1">{identities.length}</Badge>
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            All identities ever seen by this connector — pending, approved, blocked, and orphans (binding deleted).
            Use Force Reset to re-trigger the pairing flow without waiting for inbound; Delete to wipe corrupt rows.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={onRefresh}
          disabled={isFetching}
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {identities.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center border rounded-lg bg-card">
          No identities yet — bot hasn't seen any inbound messages from users.
        </div>
      ) : (
        <div className="space-y-2">
          {identities.map(row => (
            <IdentityHistoryRowView
              key={row.id}
              row={row}
              onReset={() => setConfirmReset(row)}
              onForceDelete={() => setConfirmDelete(row)}
              resetPending={resetPending}
              deletePending={deletePending}
            />
          ))}
        </div>
      )}

      <AlertDialog open={!!confirmReset} onOpenChange={(o) => { if (!o) setConfirmReset(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force reset identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the binding and sets status to <code>pending</code>. The user will re-enter the pairing flow on their next inbound message (or you can approve them from the pending queue).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmReset) onReset(confirmReset.id)
                setConfirmReset(null)
              }}
            >
              Force Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hard-delete identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This will hard-delete the row. Next inbound from this user creates a fresh pending identity. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmDelete) onForceDelete(confirmDelete.id)
                setConfirmDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function IdentityHistoryRowView({
  row,
  onReset,
  onForceDelete,
  resetPending,
  deletePending,
}: {
  row: IdentityHistoryRow
  onReset: () => void
  onForceDelete: () => void
  resetPending: boolean
  deletePending: boolean
}) {
  const isOrphan = row.binding_id === null && row.status === 'approved'
  const effectiveStatus: 'pending' | 'approved' | 'blocked' | 'orphan' = isOrphan ? 'orphan' : row.status

  const badgeClass =
    effectiveStatus === 'pending'
      ? 'bg-amber-500/10 text-amber-600 border-amber-500/20'
      : effectiveStatus === 'approved'
        ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
        : effectiveStatus === 'blocked'
          ? 'bg-rose-500/10 text-rose-600 border-rose-500/20'
          : 'bg-muted text-muted-foreground border-border'

  const username = row.external_ref_keys?.['username']
  const userId = row.external_ref_keys?.['user_id']
  const displayName = row.display_name ?? username ?? userId ?? row.id
  const bindingShort = row.binding_id ? `${row.binding_id.slice(0, 8)}…` : '—'

  const copyBinding = () => {
    if (!row.binding_id) return
    navigator.clipboard.writeText(row.binding_id).catch(() => {})
    toast.success('Binding ID copied')
  }

  const resetDisabled = resetPending || (row.status === 'pending' && row.binding_id === null)

  return (
    <div className="flex items-center justify-between py-2.5 px-4 rounded-lg border bg-card gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Badge variant="outline" className={`${badgeClass} shrink-0 capitalize`}>
          {effectiveStatus}
        </Badge>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <p className="text-[11px] text-muted-foreground font-mono truncate">
            {username ? `@${username} · ` : ''}{userId ? `user_id=${userId}` : ''}
          </p>
          <p className="text-[11px] text-muted-foreground font-mono truncate flex items-center gap-1">
            <span>binding={bindingShort}</span>
            {row.binding_id && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={copyBinding}
                      className="hover:text-foreground"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Copy binding id</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <span>· created {new Date(row.created_at).toLocaleString()}</span>
            {row.last_seen_at && <span>· last seen {new Date(row.last_seen_at).toLocaleString()}</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={onReset}
                disabled={resetDisabled}
              >
                <RefreshCw className="h-3 w-3" /> Force Reset
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear binding, set status=pending</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0 text-destructive border-destructive/40"
          onClick={onForceDelete}
          disabled={deletePending}
          title="Hard-delete identity row"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
