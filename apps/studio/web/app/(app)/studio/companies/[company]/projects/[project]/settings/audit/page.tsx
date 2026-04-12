'use client'

import { use, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type AuditLogEntry } from '@/lib/api'
import {
  Badge, Button, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@jiku/ui'
import { Download, Search, RefreshCw } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

const EVENT_TYPES = [
  'tool.invoke', 'tool.blocked',
  'file.write', 'file.delete', 'file.read',
  'secret.get', 'secret.create', 'secret.delete',
  'auth.login', 'auth.logout', 'auth.login_failed', 'auth.register',
  'member.invite', 'member.remove', 'member.role_changed',
  'permission.granted', 'permission.revoked',
  'plugin.activated', 'plugin.deactivated',
  'agent.created', 'agent.deleted',
]

export default function AuditLogPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })
  const projectId = projectsData?.id ?? null

  const [page, setPage] = useState(0)
  const [perPage] = useState(20)
  const [eventType, setEventType] = useState<string>('all')
  const [resourceType, setResourceType] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AuditLogEntry | null>(null)

  const query = useQuery({
    queryKey: ['audit-logs', projectId, page, perPage, eventType, resourceType],
    queryFn: () => api.auditLogs.list(projectId!, {
      page,
      per_page: perPage,
      event_type: eventType === 'all' ? undefined : eventType,
      resource_type: resourceType === 'all' ? undefined : resourceType,
    }),
    enabled: !!projectId,
  })

  const filteredLogs = useMemo(() => {
    const logs = query.data?.logs ?? []
    if (!search) return logs
    const q = search.toLowerCase()
    return logs.filter(l =>
      l.event_type.toLowerCase().includes(q)
      || (l.actor?.name ?? '').toLowerCase().includes(q)
      || (l.actor?.email ?? '').toLowerCase().includes(q)
      || (l.resource_name ?? '').toLowerCase().includes(q)
      || (l.resource_id ?? '').toLowerCase().includes(q),
    )
  }, [query.data, search])

  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  function download() {
    if (!projectId) return
    const url = api.auditLogs.exportUrl(projectId, {
      event_type: eventType === 'all' ? undefined : eventType,
      resource_type: resourceType === 'all' ? undefined : resourceType,
    })
    window.open(url, '_blank')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Audit Log</h2>
          <p className="text-sm text-muted-foreground">All sensitive actions in this project.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={download}>
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-56">
          <Label className="text-xs">Event type</Label>
          <Select value={eventType} onValueChange={v => { setEventType(v); setPage(0) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {EVENT_TYPES.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-56">
          <Label className="text-xs">Resource type</Label>
          <Select value={resourceType} onValueChange={v => { setResourceType(v); setPage(0) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All resources</SelectItem>
              <SelectItem value="tool">Tool</SelectItem>
              <SelectItem value="file">File</SelectItem>
              <SelectItem value="credential">Credential</SelectItem>
              <SelectItem value="auth">Auth</SelectItem>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="permission">Permission</SelectItem>
              <SelectItem value="plugin">Plugin</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 min-w-56">
          <Label className="text-xs">Search</Label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Filter visible rows…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium w-40">Time</th>
              <th className="px-3 py-2 font-medium w-48">Actor</th>
              <th className="px-3 py-2 font-medium w-48">Event</th>
              <th className="px-3 py-2 font-medium">Resource</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!query.isLoading && filteredLogs.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No audit logs.</td></tr>
            )}
            {filteredLogs.map(log => (
              <tr
                key={log.id}
                className="border-t hover:bg-muted/20 cursor-pointer"
                onClick={() => setSelected(log)}
              >
                <td className="px-3 py-2 tabular-nums text-xs">{new Date(log.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {log.actor ? (
                    <span>
                      <span className="font-medium">{log.actor.name}</span>
                      <span className="text-muted-foreground ml-1">({log.actor.email})</span>
                    </span>
                  ) : (
                    <Badge variant="outline">{log.actor_type}</Badge>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={log.event_type.endsWith('_failed') || log.event_type === 'tool.blocked' ? 'destructive' : 'secondary'}>
                    {log.event_type}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground truncate max-w-[400px]">
                  {log.resource_name ?? log.resource_id ?? log.resource_type}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {page + 1} of {totalPages} — {total} total
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</Button>
          <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      </div>

      <Sheet open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <SheetContent className="w-[560px] sm:max-w-[560px]">
          <SheetHeader>
            <SheetTitle>Audit log entry</SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="space-y-3 mt-4 text-sm">
              <Row label="Time" value={new Date(selected.created_at).toLocaleString()} />
              <Row label="Event" value={selected.event_type} />
              <Row label="Actor" value={selected.actor ? `${selected.actor.name} <${selected.actor.email}>` : selected.actor_type} />
              <Row label="Resource type" value={selected.resource_type} />
              <Row label="Resource id" value={selected.resource_id ?? '—'} />
              <Row label="Resource name" value={selected.resource_name ?? '—'} />
              <Row label="IP" value={selected.ip_address ?? '—'} />
              <Row label="User agent" value={selected.user_agent ?? '—'} />
              <div>
                <Label className="text-xs text-muted-foreground">Metadata</Label>
                <pre className="mt-1 bg-muted/40 rounded p-3 text-xs overflow-x-auto">
                  {JSON.stringify(selected.metadata, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-right break-all">{value}</span>
    </div>
  )
}
