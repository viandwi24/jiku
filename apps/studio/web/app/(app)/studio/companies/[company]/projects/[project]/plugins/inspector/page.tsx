'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { usePluginUIRegistry } from '@/lib/plugins/provider'
import { pluginUiApi } from '@/lib/plugins/api-client'
import { invalidatePlugin } from '@/lib/plugins/mount-runtime'
import { api } from '@/lib/api'
import { useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Skeleton } from '@jiku/ui'

export default function PluginInspectorPage() {
  const params = useParams<{ company: string; project: string }>()
  const company = params?.company ?? ''
  const projectSlug = params?.project ?? ''

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === company) ?? null,
    enabled: !!company,
  })
  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const projectId = projectsData?.projects.find(p => p.slug === projectSlug)?.id ?? ''

  const registry = usePluginUIRegistry()
  const [selected, setSelected] = useState<string | null>(null)

  const sel = selected ?? registry.plugins[0]?.id ?? null

  const inspector = useQuery({
    queryKey: ['plugin-inspector', sel],
    queryFn: () => pluginUiApi.inspector(sel!),
    enabled: !!sel,
    refetchInterval: 5_000,
  })

  const audit = useQuery({
    queryKey: ['plugin-audit', projectId, sel],
    queryFn: () => pluginUiApi.audit(projectId, sel ?? undefined),
    enabled: !!projectId && !!sel,
    refetchInterval: 10_000,
  })

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4 p-6">
      <aside className="flex flex-col gap-1">
        <h2 className="mb-2 text-sm font-medium">Installed</h2>
        {registry.isLoading ? (
          <>
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </>
        ) : registry.plugins.length === 0 ? (
          <p className="text-xs text-muted-foreground">No plugin UIs registered.</p>
        ) : (
          registry.plugins.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.id)}
              className={
                'flex flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent ' +
                (p.id === sel ? 'bg-accent font-medium' : '')
              }
            >
              <span className="truncate">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.id} · v{p.version}</span>
            </button>
          ))
        )}
      </aside>

      <section className="flex flex-col gap-4">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Plugin Inspector</h1>
            <p className="text-sm text-muted-foreground">
              Live status, routes, metrics, and audit log for each installed plugin.
            </p>
          </div>
          {sel && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                invalidatePlugin(sel)
                toast.success(`Reloaded "${sel}"`, { description: 'Next render pulls a fresh bundle.' })
                inspector.refetch()
              }}
            >
              Reload plugin
            </Button>
          )}
        </header>

        {!sel ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">Select a plugin.</CardContent></Card>
        ) : (
          <>
            <Card>
              <CardHeader><CardTitle className="text-base">Manifest</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {inspector.isLoading ? <Skeleton className="h-20 w-full" /> : (
                  <pre className="overflow-auto rounded bg-muted p-3 text-xs">
{JSON.stringify(inspector.data?.plugin ?? {}, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">HTTP routes</CardTitle></CardHeader>
              <CardContent>
                {(inspector.data?.routes ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">None registered.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {inspector.data?.routes.map((r, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs font-mono">
                        <Badge variant="outline">{r.method.toUpperCase()}</Badge>
                        <code>/api/plugins/{sel}/api{r.path}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Metrics</CardTitle></CardHeader>
              <CardContent className="text-xs">
                <pre className="overflow-auto rounded bg-muted p-3">
{JSON.stringify(inspector.data?.metrics ?? {}, null, 2)}
                </pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">Audit log (latest 100)</CardTitle>
                <Button size="sm" variant="outline" onClick={() => audit.refetch()}>Refresh</Button>
              </CardHeader>
              <CardContent>
                {(audit.data?.entries ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No audit entries yet.</p>
                ) : (
                  <ul className="flex max-h-96 flex-col gap-1 overflow-auto">
                    {audit.data?.entries.map((e, i) => (
                      <li key={i} className="grid grid-cols-[auto_auto_1fr] gap-2 text-xs font-mono">
                        <time className="text-muted-foreground">{String(e['created_at'] ?? '')}</time>
                        <Badge variant={e['outcome'] === 'ok' ? 'default' : 'destructive'}>{String(e['action'])}</Badge>
                        <span className="truncate">{String(e['target'] ?? '')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </section>
    </div>
  )
}
