'use client'

import { use, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type ActionRequestItem } from '@/lib/api'
import { useProjectPermission } from '@/lib/permissions'
import { withPermissionGuard } from '@/components/permissions/permission-guard'
import { Button, Badge, cn } from '@jiku/ui'
import {
  CheckCircle2, XCircle, MoreHorizontal, MessageSquare, Wrench,
  Clock as ClockIcon, AlertCircle, Inbox,
} from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

type Tab = 'active' | 'recent' | 'dropped'

function ActionCenterPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  const { can } = useProjectPermission(projectId)
  const canRespond = can('action_requests:respond')

  const statusFilter = tab === 'active' ? 'pending'
    : tab === 'dropped' ? 'dropped'
    : 'approved,rejected,answered,expired,failed'

  const { data: listData, isLoading } = useQuery({
    queryKey: ['action-requests', projectId, statusFilter],
    queryFn: () => api.actionRequests.list(projectId, { status: statusFilter, limit: 100 }),
    enabled: !!projectId,
  })

  // SSE live updates — refetch on any update for the project.
  useEffect(() => {
    if (!projectId) return
    const url = api.actionRequests.streamUrl(projectId)
    const es = new EventSource(url)
    es.onmessage = () => {
      queryClient.invalidateQueries({ queryKey: ['action-requests', projectId] })
    }
    es.onerror = () => { /* let browser auto-reconnect */ }
    return () => es.close()
  }, [projectId, queryClient])

  const items = listData?.items ?? []
  const selected = items.find(i => i.id === selectedId) ?? null

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">Action Center</h1>
          <p className="text-xs text-muted-foreground">Decisions waiting on a human.</p>
        </div>
        <div className="flex gap-1">
          <TabButton active={tab === 'active'} onClick={() => { setTab('active'); setSelectedId(null) }}>
            Active {tab === 'active' && items.length > 0 && <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">{items.length}</Badge>}
          </TabButton>
          <TabButton active={tab === 'recent'} onClick={() => { setTab('recent'); setSelectedId(null) }}>Recent</TabButton>
          <TabButton active={tab === 'dropped'} onClick={() => { setTab('dropped'); setSelectedId(null) }}>Dropped</TabButton>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-96 shrink-0 border-r overflow-auto">
          {isLoading && <p className="p-4 text-xs text-muted-foreground">Loading…</p>}
          {!isLoading && items.length === 0 && (
            <div className="p-8 text-center">
              <Inbox className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">
                {tab === 'active' ? 'No pending requests.' : tab === 'dropped' ? 'No dropped requests.' : 'No completed requests yet.'}
              </p>
            </div>
          )}
          <ul>
            {items.map(item => (
              <li key={item.id}>
                <button
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    'w-full border-b px-3 py-2.5 text-left transition-colors',
                    selectedId === item.id ? 'bg-accent' : 'hover:bg-muted/40',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <SourceIcon source={item.source_type} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <StatusBadge status={item.status} />
                      </div>
                      {item.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatRelative(item.created_at)} · {item.type}
                        {item.expires_at && tab === 'active' && (
                          <> · expires {formatRelative(item.expires_at)}</>
                        )}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex-1 overflow-auto">
          {!selected && (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <CheckCircle2 className="mx-auto h-10 w-10 text-muted-foreground/30" />
                <p className="mt-3 text-sm text-muted-foreground">Select a request</p>
              </div>
            </div>
          )}
          {selected && (
            <ActionRequestDetail
              actionRequest={selected}
              canRespond={canRespond}
              onChanged={() => {
                queryClient.invalidateQueries({ queryKey: ['action-requests', projectId] })
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1 text-sm font-medium transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function SourceIcon({ source }: { source: ActionRequestItem['source_type'] }) {
  if (source === 'outbound_message') return <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
  if (source === 'agent_tool') return <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" />
  if (source === 'task_checkpoint') return <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
  return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
}

function StatusBadge({ status }: { status: ActionRequestItem['status'] }) {
  const map: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    pending:  { label: 'pending',  variant: 'default' },
    approved: { label: 'approved', variant: 'secondary' },
    rejected: { label: 'rejected', variant: 'destructive' },
    answered: { label: 'answered', variant: 'secondary' },
    dropped:  { label: 'dropped',  variant: 'outline' },
    expired:  { label: 'expired',  variant: 'outline' },
    failed:   { label: 'failed',   variant: 'destructive' },
  }
  const m = map[status] ?? { label: status, variant: 'outline' as const }
  return <Badge variant={m.variant} className="h-4 px-1 text-[9px]">{m.label}</Badge>
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function ActionRequestDetail({
  actionRequest, canRespond, onChanged,
}: {
  actionRequest: ActionRequestItem
  canRespond: boolean
  onChanged: () => void
}) {
  const respond = useMutation({
    mutationFn: (response: unknown) => api.actionRequests.respond(actionRequest.id, { response }),
    onSuccess: () => { toast.success('Response submitted'); onChanged() },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const drop = useMutation({
    mutationFn: () => api.actionRequests.drop(actionRequest.id),
    onSuccess: () => { toast.success('Request dropped'); onChanged() },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const isPending = actionRequest.status === 'pending'
  const disabled = !canRespond || !isPending || respond.isPending || drop.isPending

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <SourceIcon source={actionRequest.source_type} />
              <h2 className="text-base font-semibold">{actionRequest.title}</h2>
              <StatusBadge status={actionRequest.status} />
            </div>
            {actionRequest.description && (
              <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">{actionRequest.description}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Created {formatRelative(actionRequest.created_at)}
              {actionRequest.expires_at && isPending && <> · Expires {formatRelative(actionRequest.expires_at)}</>}
              {actionRequest.response_at && <> · Responded {formatRelative(actionRequest.response_at)}</>}
            </p>
          </div>
          {isPending && canRespond && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs text-muted-foreground"
              disabled={drop.isPending}
              onClick={() => {
                if (!confirm('Drop this request? The source agent will not receive a decision.')) return
                drop.mutate()
              }}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
              Drop
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-5">
        {actionRequest.context && Object.keys(actionRequest.context).length > 0 && (
          <Section title="Context">
            <pre className="rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
              {JSON.stringify(actionRequest.context, null, 2)}
            </pre>
          </Section>
        )}

        {actionRequest.execution_error && (
          <Section title="Execution error">
            <pre className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive whitespace-pre-wrap break-words">
              {actionRequest.execution_error}
            </pre>
          </Section>
        )}

        {actionRequest.response != null && !isPending && (
          <Section title="Response">
            <pre className="rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
              {JSON.stringify(actionRequest.response, null, 2)}
            </pre>
          </Section>
        )}

        {isPending && (
          <Section title="Decision">
            {!canRespond && (
              <p className="text-xs text-muted-foreground">You don't have permission to respond.</p>
            )}
            {canRespond && (
              <ResponseForm
                actionRequest={actionRequest}
                disabled={disabled}
                onSubmit={(response) => respond.mutate(response)}
              />
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

// ── Per-type response forms ──────────────────────────────────────────────────

function ResponseForm({
  actionRequest, disabled, onSubmit,
}: {
  actionRequest: ActionRequestItem
  disabled: boolean
  onSubmit: (response: unknown) => void
}) {
  const spec = actionRequest.spec as Record<string, unknown>
  if (actionRequest.type === 'boolean') {
    const approveLabel = (spec['approve_label'] as string) || 'Approve'
    const rejectLabel = (spec['reject_label'] as string) || 'Reject'
    const approveStyle = spec['approve_style'] as string | undefined
    const rejectStyle = spec['reject_style'] as string | undefined
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled}
          variant={approveStyle === 'destructive' ? 'destructive' : 'default'}
          onClick={() => onSubmit({ value: true, label: approveLabel })}
        >
          <CheckCircle2 className="mr-1.5 h-4 w-4" /> {approveLabel}
        </Button>
        <Button
          disabled={disabled}
          variant={rejectStyle === 'destructive' ? 'destructive' : 'outline'}
          onClick={() => onSubmit({ value: false, label: rejectLabel })}
        >
          <XCircle className="mr-1.5 h-4 w-4" /> {rejectLabel}
        </Button>
      </div>
    )
  }

  if (actionRequest.type === 'choice') {
    const options = (spec['options'] as Array<{ value: string; label: string; style?: string; description?: string }>) ?? []
    return (
      <div className="flex flex-col gap-2">
        {options.map(opt => (
          <Button
            key={opt.value}
            disabled={disabled}
            variant={opt.style === 'destructive' ? 'destructive' : opt.style === 'primary' ? 'default' : 'outline'}
            className="justify-start"
            onClick={() => onSubmit({ value: opt.value, label: opt.label })}
          >
            <span className="flex flex-col items-start">
              <span className="font-medium">{opt.label}</span>
              {opt.description && <span className="text-xs opacity-70">{opt.description}</span>}
            </span>
          </Button>
        ))}
      </div>
    )
  }

  if (actionRequest.type === 'input') {
    return <InputResponseForm spec={spec} disabled={disabled} onSubmit={onSubmit} />
  }

  if (actionRequest.type === 'form') {
    return <FormResponseForm spec={spec} disabled={disabled} onSubmit={onSubmit} />
  }

  return <p className="text-xs text-muted-foreground">Unknown request type: {actionRequest.type}</p>
}

function InputResponseForm({
  spec, disabled, onSubmit,
}: {
  spec: Record<string, unknown>
  disabled: boolean
  onSubmit: (response: unknown) => void
}) {
  const inputKind = (spec['input_kind'] as string) || 'text'
  const placeholder = (spec['placeholder'] as string) || ''
  const defaultValue = (spec['default_value'] as string) || ''
  const minLength = spec['min_length'] as number | undefined
  const maxLength = spec['max_length'] as number | undefined
  const pattern = spec['pattern'] as string | undefined
  const hint = spec['validation_hint'] as string | undefined
  const [value, setValue] = useState(defaultValue)

  const isValid = useMemo(() => {
    if (minLength != null && value.length < minLength) return false
    if (maxLength != null && value.length > maxLength) return false
    if (pattern) {
      try { if (!new RegExp(pattern).test(value)) return false } catch { /* invalid pattern → skip */ }
    }
    return value.length > 0
  }, [value, minLength, maxLength, pattern])

  return (
    <div className="space-y-2">
      {inputKind === 'textarea' ? (
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          rows={5}
          className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 ring-ring"
        />
      ) : (
        <input
          type={inputKind === 'password' ? 'password' : inputKind === 'number' ? 'number' : inputKind === 'email' ? 'email' : inputKind === 'url' ? 'url' : 'text'}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 ring-ring"
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Button disabled={disabled || !isValid} onClick={() => onSubmit({ value })}>Submit</Button>
    </div>
  )
}

interface FormFieldSpec {
  name: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  required: boolean
  options?: Array<{ value: string; label: string }>
  default_value?: unknown
  placeholder?: string
}

function FormResponseForm({
  spec, disabled, onSubmit,
}: {
  spec: Record<string, unknown>
  disabled: boolean
  onSubmit: (response: unknown) => void
}) {
  const fields = (spec['fields'] as FormFieldSpec[]) ?? []
  const submitLabel = (spec['submit_label'] as string) || 'Submit'
  const initial = useMemo(() => {
    const o: Record<string, unknown> = {}
    for (const f of fields) o[f.name] = f.default_value ?? (f.type === 'boolean' ? false : '')
    return o
  }, [fields])
  const [values, setValues] = useState<Record<string, unknown>>(initial)

  const valid = fields.every(f => {
    if (!f.required) return true
    const v = values[f.name]
    return v != null && v !== ''
  })

  return (
    <div className="space-y-3">
      {fields.map(f => (
        <div key={f.name} className="space-y-1">
          <label className="text-xs font-medium">
            {f.label}{f.required && <span className="text-destructive"> *</span>}
          </label>
          {f.type === 'textarea' && (
            <textarea
              value={String(values[f.name] ?? '')}
              onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
              placeholder={f.placeholder}
              rows={3}
              className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 ring-ring"
            />
          )}
          {(f.type === 'text' || f.type === 'number') && (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              value={String(values[f.name] ?? '')}
              onChange={e => setValues(v => ({ ...v, [f.name]: f.type === 'number' ? Number(e.target.value) : e.target.value }))}
              placeholder={f.placeholder}
              className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 ring-ring"
            />
          )}
          {f.type === 'boolean' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(values[f.name])}
                onChange={e => setValues(v => ({ ...v, [f.name]: e.target.checked }))}
              />
              {f.placeholder ?? f.label}
            </label>
          )}
          {f.type === 'select' && (
            <select
              value={String(values[f.name] ?? '')}
              onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
              className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 ring-ring"
            >
              <option value="">{f.placeholder ?? 'Select…'}</option>
              {(f.options ?? []).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
        </div>
      ))}
      <Button disabled={disabled || !valid} onClick={() => onSubmit({ values })}>{submitLabel}</Button>
    </div>
  )
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffSec = Math.round((now - then) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60) return diffSec >= 0 ? `${abs}s ago` : `in ${abs}s`
  if (abs < 3600) return diffSec >= 0 ? `${Math.round(abs / 60)}m ago` : `in ${Math.round(abs / 60)}m`
  if (abs < 86400) return diffSec >= 0 ? `${Math.round(abs / 3600)}h ago` : `in ${Math.round(abs / 3600)}h`
  return new Date(iso).toLocaleString()
}

// satisfy lint
void useRef

export default withPermissionGuard(ActionCenterPage, 'action_requests:read')
