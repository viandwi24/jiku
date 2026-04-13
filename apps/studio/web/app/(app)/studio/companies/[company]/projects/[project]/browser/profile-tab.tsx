'use client'

import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BrowserProfile, BrowserPingResult, BrowserPreviewResult, BrowserAdapterInfo } from '@/lib/api'
import { Button, Input, Label, Separator, Switch, Badge } from '@jiku/ui'
import { ConfigField } from './config-field'
import { toast } from 'sonner'
import { Activity, CheckCircle2, XCircle, Loader2, Wifi, Monitor, ImageOff, Bug, Lock, LockOpen, Trash2, Star } from 'lucide-react'

interface Props {
  projectId: string
  profile: BrowserProfile
}

function formatIdle(idleMs: number): string {
  const sec = Math.floor(idleMs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

export function ProfileTab({ projectId, profile }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState(profile.name)
  const [cfg, setCfg] = useState<Record<string, unknown>>(profile.config)
  const [pingResult, setPingResult] = useState<BrowserPingResult | null>(null)
  const [preview, setPreview] = useState<BrowserPreviewResult | null>(null)
  const previewInFlight = useRef(false)

  // Reset local form when profile prop changes.
  useEffect(() => {
    setName(profile.name)
    setCfg(profile.config)
    setPreview(null)
    setPingResult(null)
  }, [profile.id, profile.name, profile.config])

  const { data: adaptersData } = useQuery({
    queryKey: ['browser-adapters', projectId],
    queryFn: () => api.browser.listAdapters(projectId),
  })
  const adapter: BrowserAdapterInfo | undefined = adaptersData?.adapters.find(a => a.id === profile.adapter_id)

  const { data: status } = useQuery({
    queryKey: ['browser-profile-status', projectId, profile.id],
    queryFn: () => api.browser.statusProfile(projectId, profile.id),
    enabled: !!profile.enabled,
    refetchInterval: 2000,
  })

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.browser.updateProfile(projectId, profile.id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['browser-profiles', projectId] })
      toast.success('Profile updated')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  const setDefaultMutation = useMutation({
    mutationFn: () => api.browser.setDefaultProfile(projectId, profile.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['browser-profiles', projectId] })
      toast.success('Default profile set')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  const saveMutation = useMutation({
    mutationFn: () => api.browser.updateProfile(projectId, profile.id, { name: name.trim(), config: cfg }),
    onSuccess: () => {
      setPingResult(null)
      qc.invalidateQueries({ queryKey: ['browser-profiles', projectId] })
      toast.success('Profile saved')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.browser.deleteProfile(projectId, profile.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['browser-profiles', projectId] })
      toast.success('Profile deleted')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  const pingMutation = useMutation({
    mutationFn: () => api.browser.pingProfile(projectId, profile.id),
    onSuccess: (res) => setPingResult(res),
    onError: (err) => setPingResult({ ok: false, error: err instanceof Error ? err.message : 'Request failed' }),
  })

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (previewInFlight.current) throw new Error('preview already in flight')
      previewInFlight.current = true
      try { return await api.browser.previewProfile(projectId, profile.id) }
      finally { previewInFlight.current = false }
    },
    onSuccess: (res) => setPreview(res),
    onError: (err) => {
      if (err instanceof Error && err.message === 'preview already in flight') return
      setPreview({ ok: false, error: err instanceof Error ? err.message : 'Request failed' })
    },
  })

  useEffect(() => {
    if (!profile.enabled) return
    if (!preview && !previewInFlight.current) previewMutation.mutate()
    const id = setInterval(() => {
      if (!previewInFlight.current) previewMutation.mutate()
    }, 3000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.enabled, profile.id])

  const statusTone =
    !profile.enabled ? 'idle'
      : pingResult == null ? 'unknown'
      : pingResult.ok ? 'ok' : 'error'

  const statusLabel =
    statusTone === 'idle' ? 'Profile disabled'
      : statusTone === 'unknown' ? 'Click "Test connection" to verify reachability'
      : statusTone === 'ok' ? `Connected · ${pingResult?.browser ?? 'unknown'}${pingResult?.latency_ms !== undefined ? ` · ${pingResult.latency_ms}ms` : ''}`
      : `Cannot reach endpoint — ${pingResult?.error ?? 'unknown error'}`

  return (
    <div className="space-y-8 py-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{profile.name}</h2>
            {profile.is_default && <Badge variant="secondary">Default</Badge>}
            <Badge variant="outline" className="font-mono text-[10px]">{profile.adapter_id}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Profile ID: <code className="font-mono">{profile.id}</code></p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-sm">Enabled</Label>
          <Switch
            checked={profile.enabled}
            onCheckedChange={(v) => toggleMutation.mutate(v)}
            disabled={toggleMutation.isPending}
          />
        </div>
      </div>

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
        {profile.enabled && (
          <Button variant="outline" size="sm" onClick={() => pingMutation.mutate()} disabled={pingMutation.isPending} className="shrink-0 gap-1.5">
            {pingMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            Test connection
          </Button>
        )}
      </div>

      {pingResult && (
        <div className={`flex items-start gap-3 px-4 py-3 rounded-md border text-sm ${
          pingResult.ok ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'
        }`}>
          {pingResult.ok
            ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            : <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
          <div className="space-y-1 min-w-0">
            {pingResult.ok ? (
              <>
                <p className="font-medium text-emerald-600 dark:text-emerald-400">Endpoint reachable</p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  {pingResult.cdp_url && <span>Endpoint: <code className="font-mono">{pingResult.cdp_url}</code></span>}
                  {pingResult.browser && <span>Browser: <span className="font-medium">{pingResult.browser}</span></span>}
                  {pingResult.latency_ms !== undefined && <span>Latency: <span className="tabular-nums font-medium">{pingResult.latency_ms}ms</span></span>}
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
      {profile.enabled && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2"><Monitor className="w-4 h-4" /> Live Preview</h3>
              <p className="text-xs text-muted-foreground mt-0.5">One-shot screenshot. Auto-refreshes every 3s.</p>
            </div>
          </div>
          <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-muted/30">
            {preview?.ok && preview.data ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/${preview.data.format};base64,${preview.data.base64}`} alt="Browser preview" className="absolute inset-0 h-full w-full object-contain" />
                {(preview.data.title || preview.data.url) && (
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 text-xs text-white">
                    {preview.data.title && <span className="truncate font-medium">{preview.data.title}</span>}
                    {preview.data.url && <span className="truncate font-mono text-white/70">{preview.data.url}</span>}
                  </div>
                )}
              </>
            ) : preview && !preview.ok ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
                <ImageOff className="h-6 w-6 text-red-500" />
                <p className="text-sm font-medium text-red-600 dark:text-red-400">Preview failed</p>
                <p className="text-xs text-muted-foreground max-w-sm">{preview.error ?? 'Unknown error'}</p>
                {preview.hint && <p className="text-xs text-muted-foreground italic max-w-sm">Hint: {preview.hint}</p>}
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground">Capturing screenshot...</p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Debug panel */}
      {profile.enabled && status && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2"><Bug className="w-4 h-4" /> Debug</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Per-agent tab affinity and serialization. Refreshes every 2s.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                status.mutex.busy
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              }`}>
                {status.mutex.busy ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                {status.mutex.busy ? 'busy' : 'idle'}
              </span>
              <span className="rounded-full border px-2.5 py-1 text-xs tabular-nums border-border bg-muted text-muted-foreground">
                {status.capacity.used} / {status.capacity.max} tabs
              </span>
            </div>
          </div>
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
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-muted-foreground italic">No tracked tabs yet.</td></tr>
                ) : status.tabs.map((tab) => {
                  const isSystem = tab.kind === 'system'
                  return (
                    <tr key={tab.index} className="border-t border-border/60">
                      <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{tab.index}</td>
                      <td className="px-3 py-2">{isSystem ? <span className="text-muted-foreground italic">system</span> : <span className="font-medium">{tab.agent_name ?? tab.agent_id ?? '?'}</span>}</td>
                      <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${isSystem ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>{tab.kind}</span></td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{isSystem ? '— always on' : formatIdle(tab.idle_ms)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Separator />

      {/* Config section */}
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Configuration</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Fields specific to the <code className="text-xs bg-muted px-1 rounded">{profile.adapter_id}</code> adapter.</p>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Profile Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <ConfigForm config={cfg} onChange={setCfg} adapter={adapter} />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
          {!profile.is_default && (
            <Button variant="outline" onClick={() => setDefaultMutation.mutate()} disabled={setDefaultMutation.isPending} className="gap-1.5">
              <Star className="w-3.5 h-3.5" /> Set as default
            </Button>
          )}
        </div>
      </section>

      <Separator />

      <section>
        <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">Danger Zone</h3>
        <p className="text-xs text-muted-foreground mt-0.5 mb-3">Deleting a profile closes all tracked tabs and stops tool routing to it.</p>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(`Delete profile "${profile.name}"?`)) deleteMutation.mutate()
          }}
          disabled={deleteMutation.isPending}
          className="gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete Profile
        </Button>
      </section>
    </div>
  )
}

interface ConfigFormProps {
  config: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  adapter: BrowserAdapterInfo | undefined
}

// Render the full adapter schema — every field shows with its proper control,
// humanized label, description, default-as-placeholder, and numeric bounds.
// Falls back to inferring from persisted values only when the adapter schema
// is not (yet) available (e.g. the adapter plugin is not loaded).
function ConfigForm({ config, onChange, adapter }: ConfigFormProps) {
  if (adapter && Object.keys(adapter.config_fields).length > 0) {
    return (
      <div className="space-y-4 rounded-md border p-4 bg-muted/20">
        {Object.entries(adapter.config_fields).map(([key, field]) => (
          <ConfigField
            key={key}
            name={key}
            field={field}
            value={config[key]}
            onChange={(next) => {
              const copy = { ...config }
              if (next === undefined) delete copy[key]
              else copy[key] = next
              onChange(copy)
            }}
          />
        ))}
      </div>
    )
  }

  const entries = Object.entries(config)
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Adapter <code className="font-mono">{adapter?.id ?? 'unknown'}</code> is not currently registered — cannot render config form.
      </p>
    )
  }
  return (
    <div className="space-y-2 rounded-md border p-3 bg-muted/20">
      <p className="text-xs text-muted-foreground italic">
        Showing raw persisted values — adapter schema unavailable.
      </p>
      {entries.map(([key, value]) => (
        <div key={key} className="space-y-1">
          <Label className="text-xs font-mono">{key}</Label>
          {typeof value === 'boolean' ? (
            <Switch checked={value} onCheckedChange={(v) => onChange({ ...config, [key]: v })} />
          ) : typeof value === 'number' ? (
            <Input type="number" value={value} onChange={(e) => onChange({ ...config, [key]: e.target.value ? Number(e.target.value) : undefined })} />
          ) : (
            <Input value={String(value ?? '')} onChange={(e) => onChange({ ...config, [key]: e.target.value || undefined })} />
          )}
        </div>
      ))}
    </div>
  )
}
