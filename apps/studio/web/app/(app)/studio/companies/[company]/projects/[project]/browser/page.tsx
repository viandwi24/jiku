'use client'

import { use, useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BrowserProjectConfig, BrowserPingResult, BrowserPreviewResult, BrowserStatus } from '@/lib/api'
import { Button, Input, Label, Separator, Switch } from '@jiku/ui'
import { toast } from 'sonner'
import { Activity, CheckCircle2, XCircle, Loader2, Wifi, Globe, Monitor, ImageOff, Bug, Lock, LockOpen } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function ProjectBrowserPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)
  const projectId = project?.id ?? ''

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['project-browser', projectId],
    queryFn: () => api.browser.get(projectId),
    enabled: !!projectId,
  })

  // Diagnostic snapshot — re-fetched on a 2s interval whenever the feature
  // is enabled. This drives the Debug panel (tab table + mutex badge).
  const { data: status } = useQuery({
    queryKey: ['project-browser-status', projectId],
    queryFn: () => api.browser.status(projectId),
    enabled: !!projectId && !!data?.enabled,
    refetchInterval: 2000,
  })

  const [enabled, setEnabled] = useState(false)
  const [cfg, setCfg] = useState<BrowserProjectConfig>({})
  const [initialized, setInitialized] = useState(false)
  const [pingResult, setPingResult] = useState<BrowserPingResult | null>(null)
  const [preview, setPreview] = useState<BrowserPreviewResult | null>(null)
  const previewInFlight = useRef(false)

  useEffect(() => {
    if (data && !initialized) {
      setEnabled(data.enabled)
      setCfg(data.config ?? {})
      setInitialized(true)
    }
  }, [data, initialized])

  const enableMutation = useMutation({
    mutationFn: (val: boolean) => api.browser.setEnabled(projectId, val),
    onSuccess: (_res, val) => {
      setEnabled(val)
      setPingResult(null)
      qc.invalidateQueries({ queryKey: ['project-browser', projectId] })
      toast.success(val ? 'Browser enabled' : 'Browser disabled')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const saveMutation = useMutation({
    mutationFn: () => api.browser.updateConfig(projectId, cfg),
    onSuccess: () => {
      setInitialized(false)
      setPingResult(null)
      qc.invalidateQueries({ queryKey: ['project-browser', projectId] })
      refetch()
      toast.success('Browser config saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const pingMutation = useMutation({
    mutationFn: () => api.browser.ping(projectId),
    onSuccess: (res) => setPingResult(res),
    onError: (err) => setPingResult({ ok: false, error: err instanceof Error ? err.message : 'Request failed' }),
  })

  const previewMutation = useMutation({
    mutationFn: async () => {
      // Guard against overlapping requests when auto-refresh fires faster
      // than the screenshot can complete.
      if (previewInFlight.current) {
        throw new Error('preview already in flight')
      }
      previewInFlight.current = true
      try {
        return await api.browser.preview(projectId)
      } finally {
        previewInFlight.current = false
      }
    },
    onSuccess: (res) => setPreview(res),
    onError: (err) => {
      if (err instanceof Error && err.message === 'preview already in flight') return
      setPreview({ ok: false, error: err instanceof Error ? err.message : 'Request failed' })
    },
  })

  // Auto-refresh loop. Polls every 3s while enabled and the toggle is on.
  // Cleared when the page unmounts, the feature is disabled, or the toggle
  // turns off.
  useEffect(() => {
    if (!enabled || !projectId) return
    if (!preview && !previewInFlight.current) previewMutation.mutate()
    const id = setInterval(() => {
      if (!previewInFlight.current) previewMutation.mutate()
    }, 3000)
    return () => clearInterval(id)
    // We intentionally exclude `previewMutation` from deps — its identity
    // changes on every render and we don't want to reset the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId])

  // Reset preview state when the project or feature toggle changes.
  useEffect(() => {
    setPreview(null)
  }, [projectId, enabled])

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Loading...</div>
  }

  // Format an idle duration as "12s" / "3m 45s" / "1h 4m" — short and
  // readable for the debug panel rows.
  const formatIdle = (idleMs: number): string => {
    const sec = Math.floor(idleMs / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ${sec % 60}s`
    const hr = Math.floor(min / 60)
    return `${hr}h ${min % 60}m`
  }

  // Status bar reflects the most recent ping result. If we haven't pinged yet,
  // we only know whether the feature is enabled — not whether the CDP endpoint
  // is reachable.
  const statusTone =
    !enabled
      ? 'idle'
      : pingResult == null
        ? 'unknown'
        : pingResult.ok
          ? 'ok'
          : 'error'

  const statusLabel =
    statusTone === 'idle'
      ? 'Browser disabled'
      : statusTone === 'unknown'
        ? 'Enabled — click "Test connection" to check the CDP endpoint'
        : statusTone === 'ok'
          ? `Connected · ${pingResult?.browser ?? 'unknown'}${pingResult?.latency_ms !== undefined ? ` · ${pingResult.latency_ms}ms` : ''}`
          : `Cannot reach CDP — ${pingResult?.error ?? 'unknown error'}`

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Browser</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure browser automation for agents in this project. Powered by{' '}
          <code className="text-xs bg-muted px-1 rounded">@jiku/browser</code> over CDP.
        </p>
      </div>

      {/* Enable toggle — pinned to the top so the on/off switch is the first
          thing users see, ahead of any test/preview/debug widgets that only
          make sense once the feature is on. */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Browser Automation</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Inject browser tools into all agents in this project. Agents can navigate, screenshot, and interact with web pages.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium">Enable browser tools</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              When enabled, all agents in this project receive the <code className="text-xs bg-muted px-1 rounded">browser</code> tool.
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={enableMutation.isPending || !projectId}
            onCheckedChange={(v) => enableMutation.mutate(v)}
          />
        </div>
      </section>

      <Separator />

      {/* Status bar */}
      <div className="flex items-center gap-3">
        <div
          className={`flex items-center gap-2 flex-1 px-4 py-2.5 rounded-md border text-sm ${
            statusTone === 'idle'
              ? 'bg-muted border-border text-muted-foreground'
              : statusTone === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                : statusTone === 'error'
                  ? 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400'
                  : 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400'
          }`}
        >
          <Activity className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{statusLabel}</span>
        </div>

        {enabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => pingMutation.mutate()}
            disabled={pingMutation.isPending || !projectId}
            className="shrink-0 gap-1.5"
          >
            {pingMutation.isPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Wifi className="w-3.5 h-3.5" />}
            Test connection
          </Button>
        )}
      </div>

      {/* Ping detail */}
      {pingResult && (
        <div
          className={`flex items-start gap-3 px-4 py-3 rounded-md border text-sm ${
            pingResult.ok
              ? 'bg-emerald-500/10 border-emerald-500/20'
              : 'bg-red-500/10 border-red-500/20'
          }`}
        >
          {pingResult.ok
            ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            : <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
          <div className="space-y-1 min-w-0">
            {pingResult.ok ? (
              <>
                <p className="font-medium text-emerald-600 dark:text-emerald-400">CDP reachable</p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  {pingResult.cdp_url && (
                    <span>Endpoint: <code className="font-mono">{pingResult.cdp_url}</code></span>
                  )}
                  {pingResult.browser && (
                    <span>Browser: <span className="font-medium">{pingResult.browser}</span></span>
                  )}
                  {pingResult.latency_ms !== undefined && (
                    <span>Latency: <span className="tabular-nums font-medium">{pingResult.latency_ms}ms</span></span>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="font-medium text-red-600 dark:text-red-400">Connection failed</p>
                <p className="text-xs text-muted-foreground">{pingResult.error}</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Live preview */}
      {enabled && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Monitor className="w-4 h-4" /> Live Preview
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                One-shot screenshot of the current browser state. Useful to confirm what your agents are looking at.
              </p>
            </div>
          </div>

          {/* Preview viewport — 16:9 box with the latest screenshot */}
          <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-muted/30">
            {preview?.ok && preview.data ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/${preview.data.format};base64,${preview.data.base64}`}
                  alt="Browser preview"
                  className="absolute inset-0 h-full w-full object-contain"
                />
                {(preview.data.title || preview.data.url) && (
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 text-xs text-white">
                    {preview.data.title && (
                      <span className="truncate font-medium">{preview.data.title}</span>
                    )}
                    {preview.data.url && (
                      <span className="truncate font-mono text-white/70">{preview.data.url}</span>
                    )}
                  </div>
                )}
                {previewMutation.isPending && (
                  <div className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5">
                    <Loader2 className="h-3 w-3 animate-spin text-white" />
                  </div>
                )}
              </>
            ) : preview && !preview.ok ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
                <ImageOff className="h-6 w-6 text-red-500" />
                <p className="text-sm font-medium text-red-600 dark:text-red-400">Preview failed</p>
                <p className="text-xs text-muted-foreground max-w-sm">{preview.error ?? 'Unknown error'}</p>
                {preview.hint && (
                  <p className="text-xs text-muted-foreground italic max-w-sm">Hint: {preview.hint}</p>
                )}
              </div>
            ) : previewMutation.isPending ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Capturing screenshot...</p>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
                <Monitor className="h-6 w-6 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Click <span className="font-medium">Refresh</span> to capture the current browser state.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Debug panel — tab + mutex diagnostics */}
      {enabled && status && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Bug className="w-4 h-4" /> Debug
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Per-agent tab affinity and serialization state. Refreshes every 2 seconds.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  status.mutex.busy
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                }`}
                title={status.mutex.busy ? 'A command is currently executing or queued' : 'Idle'}
              >
                {status.mutex.busy
                  ? <Lock className="h-3 w-3" />
                  : <LockOpen className="h-3 w-3" />}
                {status.mutex.busy ? 'busy' : 'idle'}
              </span>
              <span
                className={`rounded-full border px-2.5 py-1 text-xs tabular-nums ${
                  status.capacity.used >= status.capacity.max
                    ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400'
                    : 'border-border bg-muted text-muted-foreground'
                }`}
                title={`${status.capacity.agent_used} agent tab(s) + ${status.capacity.used - status.capacity.agent_used} system tab(s)`}
              >
                {status.capacity.used} / {status.capacity.max} tabs
              </span>
            </div>
          </div>

          {/* Capacity bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all ${
                status.capacity.used >= status.capacity.max
                  ? 'bg-red-500'
                  : status.capacity.used >= status.capacity.max * 0.7
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, (status.capacity.used / status.capacity.max) * 100)}%` }}
            />
          </div>

          {/* Tab table */}
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Owner</th>
                  <th className="px-3 py-2 text-left font-medium">Kind</th>
                  <th className="px-3 py-2 text-right font-medium">Idle</th>
                </tr>
              </thead>
              <tbody>
                {status.tabs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-muted-foreground italic">
                      No tracked tabs yet. Tabs are created on first browser tool call from each agent.
                    </td>
                  </tr>
                ) : (
                  status.tabs.map((tab) => {
                    const isSystem = tab.kind === 'system'
                    const isStale = !isSystem && tab.idle_ms > status.idle_timeout_ms
                    return (
                      <tr key={tab.index} className="border-t border-border/60">
                        <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{tab.index}</td>
                        <td className="px-3 py-2">
                          {isSystem ? (
                            <span
                              className="text-muted-foreground italic"
                              title="Container startup tab (about:blank). Owned by no agent."
                            >
                              system
                            </span>
                          ) : (
                            <span className="font-medium">{tab.agent_name ?? tab.agent_id ?? '?'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                              isSystem
                                ? 'bg-muted text-muted-foreground'
                                : 'bg-primary/10 text-primary'
                            }`}
                          >
                            {tab.kind}
                          </span>
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-mono tabular-nums ${
                            isStale
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground'
                          }`}
                          title={
                            isSystem
                              ? 'System tab is never evicted — idle timer does not apply'
                              : isStale
                                ? 'Idle past timeout — will be evicted on next cleanup tick'
                                : undefined
                          }
                        >
                          {isSystem ? '— always on' : formatIdle(tab.idle_ms)}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Each agent gets its own chromium tab. Commands are serialized per project to avoid races
            on the active tab. Idle agent tabs are closed after {Math.round(status.idle_timeout_ms / 60000)} minutes.
            When the project hits {status.capacity.max} tabs, the least-recently-used agent tab is evicted.
            Index 0 is always the system tab (about:blank from container startup) and is never evicted —
            it's the fallback target after every agent tab is gone.
          </p>
        </section>
      )}

      {/* CDP endpoint */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Globe className="w-4 h-4" /> CDP Endpoint
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Chrome DevTools Protocol endpoint. Run the bundled container with{' '}
            <code className="text-xs bg-muted px-1 rounded">docker compose up -d</code> in{' '}
            <code className="text-xs bg-muted px-1 rounded">packages/browser</code>, or point to any other CDP-enabled Chromium.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">CDP URL</Label>
          <Input
            placeholder="ws://localhost:9222"
            value={cfg.cdp_url ?? ''}
            onChange={(e) => setCfg(p => ({ ...p, cdp_url: e.target.value || undefined }))}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Defaults to <code className="text-xs bg-muted px-1 rounded">ws://localhost:9222</code> if left blank.
            Both <code className="text-xs bg-muted px-1 rounded">ws://</code> and{' '}
            <code className="text-xs bg-muted px-1 rounded">http://</code> are accepted —{' '}
            <code className="text-xs bg-muted px-1 rounded">@jiku/browser</code> normalizes to <code>http://</code>.
          </p>
        </div>
      </section>

      <Separator />

      {/* Advanced */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Advanced</h2>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Timeout (ms)</Label>
            <p className="text-xs text-muted-foreground">Per-command timeout for the agent-browser CLI. Default: 30000.</p>
            <Input
              type="number"
              placeholder="30000"
              value={cfg.timeout_ms ?? ''}
              onChange={(e) => setCfg(p => ({ ...p, timeout_ms: e.target.value ? Number(e.target.value) : undefined }))}
              className="w-36 font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Max tabs</Label>
            <p className="text-xs text-muted-foreground">
              Hard cap on chromium tabs for this project, including the system tab at index 0.
              When the cap is hit, the least-recently-used agent tab is evicted before opening a new one.
              Default: 10. Allowed: 2..50.
            </p>
            <Input
              type="number"
              min={2}
              max={50}
              placeholder="10"
              value={cfg.max_tabs ?? ''}
              onChange={(e) => setCfg(p => ({ ...p, max_tabs: e.target.value ? Number(e.target.value) : undefined }))}
              className="w-36 font-mono text-sm"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Persist screenshots as attachments</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                If enabled (default), screenshots are uploaded to the project filesystem and returned as attachment references. If disabled, they are returned inline as base64.
              </p>
            </div>
            <Switch
              checked={cfg.screenshot_as_attachment ?? true}
              onCheckedChange={(v) => setCfg(p => ({ ...p, screenshot_as_attachment: v }))}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Allow eval</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permit agents to execute arbitrary JavaScript in the page context. Off by default — only enable for trusted agents.
              </p>
            </div>
            <Switch
              checked={cfg.evaluate_enabled ?? false}
              onCheckedChange={(v) => setCfg(p => ({ ...p, evaluate_enabled: v }))}
            />
          </div>
        </div>
      </section>

      <div className="pt-2">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !projectId}>
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(ProjectBrowserPage, 'agents:read')
