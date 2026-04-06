'use client'

import { use, useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BrowserProjectConfig } from '@/lib/api'
import { Button, Input, Label, Separator, Switch } from '@jiku/ui'
import { toast } from 'sonner'
import { Globe, Monitor, Activity, CheckCircle2, XCircle, Loader2, Wifi } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

type PingResult = {
  ok: boolean
  error?: string
  latency_ms?: number
  cdp_latency_ms?: number
  browser?: string
  cdp_url?: string
  port?: number
}

export default function ProjectBrowserPage({ params }: PageProps) {
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
    refetchInterval: 5000,
  })

  const [enabled, setEnabled] = useState(false)
  const [cfg, setCfg] = useState<BrowserProjectConfig>({})
  const [initialized, setInitialized] = useState(false)
  const [pingResult, setPingResult] = useState<PingResult | null>(null)

  useEffect(() => {
    if (data && !initialized) {
      setEnabled(data.enabled)
      setCfg(data.config ?? {})
      setInitialized(true)
    }
  }, [data, initialized])

  const enableMutation = useMutation({
    mutationFn: (val: boolean) => api.browser.setEnabled(projectId, val),
    onSuccess: (res, val) => {
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

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Loading...</div>
  }

  const status = data?.status
  const mode = cfg.mode ?? 'managed'

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Browser</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure browser automation for agents in this project.</p>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3">
        <div className={`flex items-center gap-2 flex-1 px-4 py-2.5 rounded-md border text-sm ${
          !enabled
            ? 'bg-muted border-border text-muted-foreground'
            : status?.running
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400'
        }`}>
          <Activity className="w-3.5 h-3.5 shrink-0" />
          <span>
            {!enabled
              ? 'Browser disabled'
              : status?.running
                ? `Running${status.port ? ` · port ${status.port}` : ''}`
                : 'Stopped — enable and save to start'}
          </span>
        </div>

        {enabled && status?.running && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => pingMutation.mutate()}
            disabled={pingMutation.isPending}
            className="shrink-0 gap-1.5"
          >
            {pingMutation.isPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Wifi className="w-3.5 h-3.5" />}
            Test connection
          </Button>
        )}
      </div>

      {/* Ping result */}
      {pingResult && (
        <div className={`flex items-start gap-3 px-4 py-3 rounded-md border text-sm ${
          pingResult.ok
            ? 'bg-emerald-500/10 border-emerald-500/20'
            : 'bg-red-500/10 border-red-500/20'
        }`}>
          {pingResult.ok
            ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            : <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
          <div className="space-y-1 min-w-0">
            {pingResult.ok ? (
              <>
                <p className="font-medium text-emerald-600 dark:text-emerald-400">Connection successful</p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  {pingResult.latency_ms !== undefined && (
                    <span>Control server: <span className="tabular-nums font-medium">{pingResult.latency_ms}ms</span></span>
                  )}
                  {pingResult.cdp_latency_ms !== undefined && (
                    <span>CDP: <span className="tabular-nums font-medium">{pingResult.cdp_latency_ms}ms</span></span>
                  )}
                  {pingResult.browser && (
                    <span>Browser: <span className="font-medium">{pingResult.browser}</span></span>
                  )}
                  {pingResult.port && (
                    <span>Port: <span className="tabular-nums font-medium">{pingResult.port}</span></span>
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

      {/* Enable toggle */}
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
              Starts a browser control server and makes it available to all agents.
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={enableMutation.isPending}
            onCheckedChange={(v) => enableMutation.mutate(v)}
          />
        </div>
      </section>

      <Separator />

      {/* Mode selection */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Connection Mode</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose between a locally managed Playwright browser or a remote browser via CDP.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setCfg(p => ({ ...p, mode: 'managed' }))}
            className={`flex flex-col gap-1.5 p-4 rounded-lg border text-left transition-colors ${
              mode === 'managed'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4" />
              <span className="text-sm font-medium">Managed</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Jiku starts and manages a local Playwright browser instance.
            </p>
          </button>

          <button
            onClick={() => setCfg(p => ({ ...p, mode: 'remote' }))}
            className={`flex flex-col gap-1.5 p-4 rounded-lg border text-left transition-colors ${
              mode === 'remote'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4" />
              <span className="text-sm font-medium">Remote</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Connect to an existing browser via CDP (e.g. a Docker container).
            </p>
          </button>
        </div>

        {mode === 'remote' && (
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">CDP URL</Label>
            <p className="text-xs text-muted-foreground">
              Chrome DevTools Protocol endpoint. For{' '}
              <code className="text-xs bg-muted px-1 rounded">linuxserver/chromium</code>, use{' '}
              <code className="text-xs bg-muted px-1 rounded">http://localhost:9222</code>.
            </p>
            <Input
              placeholder="http://localhost:9223"
              value={cfg.cdp_url ?? ''}
              onChange={(e) => setCfg(p => ({ ...p, cdp_url: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
        )}
      </section>

      {mode === 'managed' && (
        <>
          <Separator />
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold">Local Browser Options</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Settings for the locally managed Playwright browser.</p>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label className="text-sm font-medium">Headless mode</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Run browser without a display. Recommended for server environments.</p>
                </div>
                <Switch
                  checked={cfg.headless ?? true}
                  onCheckedChange={(v) => setCfg(p => ({ ...p, headless: v }))}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label className="text-sm font-medium">No sandbox</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Disable Chrome sandbox. Required in some Docker/Linux environments.</p>
                </div>
                <Switch
                  checked={cfg.no_sandbox ?? false}
                  onCheckedChange={(v) => setCfg(p => ({ ...p, no_sandbox: v }))}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Executable path</Label>
                <p className="text-xs text-muted-foreground">Path to Chrome/Chromium binary. Leave blank to use the bundled Playwright browser.</p>
                <Input
                  placeholder="/usr/bin/google-chrome"
                  value={cfg.executable_path ?? ''}
                  onChange={(e) => setCfg(p => ({ ...p, executable_path: e.target.value || undefined }))}
                  className="font-mono text-sm"
                />
              </div>
            </div>
          </section>
        </>
      )}

      <Separator />

      {/* Advanced */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Advanced</h2>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-medium">Allow evaluate</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Permit agents to execute arbitrary JavaScript in the browser context.</p>
            </div>
            <Switch
              checked={cfg.evaluate_enabled ?? false}
              onCheckedChange={(v) => setCfg(p => ({ ...p, evaluate_enabled: v }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Control port</Label>
            <p className="text-xs text-muted-foreground">Port for the browser control server. Leave blank for auto-assign.</p>
            <Input
              type="number"
              placeholder="auto"
              value={cfg.control_port ?? ''}
              onChange={(e) => setCfg(p => ({ ...p, control_port: e.target.value ? Number(e.target.value) : undefined }))}
              className="w-36 font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Timeout (ms)</Label>
            <p className="text-xs text-muted-foreground">Default timeout for browser actions. Leave blank for default (30000ms).</p>
            <Input
              type="number"
              placeholder="30000"
              value={cfg.timeout_ms ?? ''}
              onChange={(e) => setCfg(p => ({ ...p, timeout_ms: e.target.value ? Number(e.target.value) : undefined }))}
              className="w-36 font-mono text-sm"
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
