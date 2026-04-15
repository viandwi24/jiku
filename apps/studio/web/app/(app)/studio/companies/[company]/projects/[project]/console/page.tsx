'use client'

import { use, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Badge, Button, Card, CardContent, Input } from '@jiku/ui'
import { ScrollText, Search, Webhook } from 'lucide-react'
import { api } from '@/lib/api'
import { ConsolePanel } from '@/components/console/console-panel'
import { withPermissionGuard } from '@/components/permissions/permission-guard'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

/**
 * Project-level unified console viewer.
 *
 * Lists every active console id registered on the server and intersects it
 * with this project's known connectors so operators can pick a session and
 * watch its live log stream without navigating into each connector's detail
 * page. Useful when debugging cross-connector flows.
 */
function ConsolePage({ params }: PageProps) {
  const { company, project } = use(params)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === company) ?? null,
  })
  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const projectId = projectsData?.projects.find(p => p.slug === project)?.id

  const connectorsQuery = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.connectors.list(projectId!),
    enabled: !!projectId,
  })

  const consolesQuery = useQuery({
    queryKey: ['console-list'],
    queryFn: () => api.console.list(),
    refetchInterval: 5000,
  })

  // Intersect server-known consoles with this project's connectors so we
  // only show sessions that actually belong here. Free-form consoles (not
  // attached to a connector) are hidden — they can be accessed by direct id
  // if needed, but the unified list is scoped to the current project.
  const items = useMemo(() => {
    const connectors = connectorsQuery.data?.connectors ?? []
    const projectConsoleIds = new Set(
      connectors.map(c => `${c.plugin_id}:connector:${c.id}`)
    )
    const consoles = consolesQuery.data?.consoles ?? []
    const byId = new Map(consoles.map(c => [c.id, c]))
    return connectors
      .map(c => {
        const id = `${c.plugin_id}:connector:${c.id}`
        const srv = byId.get(id)
        return {
          id,
          label: c.display_name,
          sublabel: c.plugin_id,
          status: c.status,
          active: !!srv,
          size: srv?.size ?? 0,
          connectorId: c.id,
        }
      })
      .filter(x => {
        if (!query) return true
        const q = query.toLowerCase()
        return x.label.toLowerCase().includes(q) || x.id.toLowerCase().includes(q) || x.sublabel.toLowerCase().includes(q)
      })
      .filter(x => projectConsoleIds.has(x.id))
  }, [connectorsQuery.data, consolesQuery.data, query])

  const base = `/studio/companies/${company}/projects/${project}`

  return (
    <div className="p-6 space-y-4 max-w-[1400px]">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <ScrollText className="h-5 w-5" /> Console
        </h1>
        <Badge variant="outline" className="text-xs">session-scoped</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Live log streams from every connector instance in this project. Logs are ephemeral — cleared when the server restarts.
      </p>

      <div className="grid grid-cols-[280px_1fr] gap-4">
        {/* Left: session list */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="pl-7 h-8 text-xs"
            />
          </div>

          {items.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="py-6 text-center text-xs text-muted-foreground">
                No consoles.
                <br />
                <Link href={`${base}/channels`} className="text-primary underline mt-2 inline-block">
                  Activate a connector
                </Link>
              </CardContent>
            </Card>
          )}

          <div className="space-y-1">
            {items.map(item => (
              <button
                key={item.id}
                onClick={() => setSelected(item.id)}
                className={`w-full text-left p-2 rounded-md border text-xs transition-colors ${
                  selected === item.id
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent hover:border-border hover:bg-muted/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Webhook className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium truncate flex-1">{item.label}</span>
                  {item.active ? (
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" title="active session" />
                  ) : (
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" title="no session" />
                  )}
                </div>
                <div className="text-muted-foreground text-[10px] mt-0.5 truncate">{item.sublabel}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: selected console */}
        <div>
          {!selected ? (
            <Card className="border-dashed h-full">
              <CardContent className="flex flex-col items-center justify-center min-h-[400px] text-sm text-muted-foreground gap-2">
                <ScrollText className="h-8 w-8 opacity-30" />
                <p>Pick a session from the list to view its console.</p>
              </CardContent>
            </Card>
          ) : (
            <ConsolePanel consoleId={selected} height="calc(100vh - 220px)" variant="terminal" />
          )}
        </div>
      </div>
    </div>
  )
}

export default withPermissionGuard(ConsolePage, 'console:read')
