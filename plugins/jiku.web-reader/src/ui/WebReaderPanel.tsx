// Web Reader — Studio panel.
//
// Three tabs, one screen:
//   • Playground — paste a URL, pick a format, hit Read, see the rendered
//     article + structured metadata. Doesn't persist to history unless
//     "Save to history" is checked.
//   • History — per-project list of previous fetches (title, site, date).
//     Click a row to re-run it in the playground.
//   • Settings — view the current plugin defaults (user-agent behaviour,
//     timeout, size cap, output format, SSRF posture). These mirror what
//     the agent tools use unless overridden per-call.

import { useEffect, useMemo, useState } from 'react'
import {
  defineMountable,
  PluginPage,
  PluginSection,
  PluginCard,
  usePluginQuery,
} from '@jiku/kit/ui'
import type { StudioComponentProps } from '@jiku-plugin/studio'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReadResult {
  url: string
  final_url: string
  status: number
  title: string | null
  byline: string | null
  excerpt: string | null
  site_name: string | null
  published_time: string | null
  author: string | null
  lead_image: string | null
  lang: string | null
  length: number
  content: string | null
  format: 'markdown' | 'html' | 'text'
  probably_readerable: boolean
  duration_ms: number
  bytes: number
}

interface ReadMetadata {
  title?: string
  description?: string
  author?: string
  siteName?: string
  publishedTime?: string
  modifiedTime?: string
  leadImage?: string
  canonicalUrl?: string
  lang?: string
  keywords?: string[]
  ogType?: string
  twitterCard?: string
}

interface HistoryEntry {
  id: string
  url: string
  finalUrl: string
  title: string | null
  siteName: string | null
  author: string | null
  leadImage: string | null
  excerpt: string | null
  length: number
  status: number
  fetchedAt: string
  durationMs: number
  bytes: number
  error?: string
}

interface Config {
  user_agent?: string
  timeout_ms: number
  max_bytes: number
  default_format: 'markdown' | 'html' | 'text'
  strip_images: boolean
  allow_private_networks: boolean
}

type Tab = 'playground' | 'history' | 'settings'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function renderMarkdownPreview(md: string): string {
  // Lightweight preview — NOT a full Markdown renderer. We only escape HTML
  // and convert headings + paragraphs so the playground shows recognisable
  // structure. For a real Markdown view, wire in a proper library later.
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split(/\n{2,}/)
    .map(block => {
      const h = block.match(/^(#{1,6})\s+(.+)$/)
      if (h) {
        const level = h[1]!.length
        return `<h${level} style="margin:1em 0 .4em;font-weight:600">${h[2]}</h${level}>`
      }
      return `<p style="margin:.7em 0;line-height:1.6">${block.replace(/\n/g, '<br/>')}</p>`
    })
    .join('')
}

// ── Component ─────────────────────────────────────────────────────────────────

function WebReaderPanel({ ctx }: StudioComponentProps) {
  const [tab, setTab] = useState<Tab>('playground')

  // Playground state
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<'markdown' | 'html' | 'text'>('markdown')
  const [stripImages, setStripImages] = useState(false)
  const [saveHistory, setSaveHistory] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ReadResult | null>(null)
  const [metadata, setMetadata] = useState<ReadMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<'rendered' | 'raw' | 'metadata'>('rendered')

  // History state
  const historyQ = usePluginQuery<{ entries: HistoryEntry[] }>(ctx, 'history')
  const configQ = usePluginQuery<{ config: Config }>(ctx, 'config')

  // Default format once config loads
  useEffect(() => {
    if (configQ.data?.config?.default_format) setFormat(configQ.data.config.default_format)
    if (configQ.data?.config?.strip_images !== undefined) setStripImages(configQ.data.config.strip_images)
  }, [configQ.data?.config?.default_format, configQ.data?.config?.strip_images])

  async function handleRead(overrideUrl?: string) {
    const target = (overrideUrl ?? url).trim()
    if (!target) return
    setRunning(true)
    setError(null)
    try {
      const res = (await ctx.api.mutate('read', {
        url: target,
        format,
        strip_images: stripImages,
        save_history: saveHistory,
      })) as { ok: boolean; result?: ReadResult; metadata?: ReadMetadata; error?: string }
      if (!res.ok) {
        setError(res.error ?? 'Unknown error')
        setResult(null)
        setMetadata(null)
      } else {
        setResult(res.result ?? null)
        setMetadata(res.metadata ?? null)
        if (overrideUrl) setUrl(overrideUrl)
      }
      if (saveHistory) await historyQ.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const pluginApiBase = `/api/plugins/${ctx.plugin.id}/api`

  async function handleClearHistory() {
    if (!confirm('Clear all web reader history for this project?')) return
    try {
      await ctx.studio.api.delete(`${pluginApiBase}/history`)
      await historyQ.refetch()
      ctx.ui.toast({ title: 'History cleared', variant: 'success' })
    } catch (err) {
      ctx.ui.toast({ title: 'Failed to clear', description: err instanceof Error ? err.message : String(err), variant: 'error' })
    }
  }

  async function handleDeleteEntry(id: string) {
    try {
      await ctx.studio.api.delete(`${pluginApiBase}/history/${id}`)
      await historyQ.refetch()
    } catch (err) {
      ctx.ui.toast({ title: 'Failed to delete entry', description: err instanceof Error ? err.message : String(err), variant: 'error' })
    }
  }

  const tabButtons: { id: Tab; label: string }[] = [
    { id: 'playground', label: 'Playground' },
    { id: 'history', label: `History${historyQ.data ? ` (${historyQ.data.entries.length})` : ''}` },
    { id: 'settings', label: 'Settings' },
  ]

  const previewHtml = useMemo(() => {
    if (!result?.content) return null
    if (result.format === 'html') return result.content
    if (result.format === 'markdown') return renderMarkdownPreview(result.content)
    return `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;line-height:1.55">${result.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
  }, [result])

  return (
    <PluginPage
      title="Web Reader"
      description={`Scrape public URLs into clean reader-mode articles. Plugin ${ctx.plugin.id} v${ctx.plugin.version}.`}
      actions={
        <div className="flex gap-1 rounded border p-0.5">
          {tabButtons.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded px-3 py-1 text-xs transition ${tab === t.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {tab === 'playground' && (
        <>
          <PluginSection title="Fetch a URL">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !running) handleRead() }}
                  placeholder="https://example.com/article"
                  className="flex-1 min-w-[280px] rounded border px-3 py-2 text-sm"
                  disabled={running}
                />
                <select
                  value={format}
                  onChange={e => setFormat(e.target.value as 'markdown' | 'html' | 'text')}
                  className="rounded border px-2 py-2 text-xs"
                  disabled={running}
                >
                  <option value="markdown">Markdown</option>
                  <option value="html">HTML</option>
                  <option value="text">Plain text</option>
                </select>
                <button
                  type="button"
                  onClick={() => handleRead()}
                  disabled={running || !url.trim()}
                  className="rounded bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {running ? 'Reading…' : 'Read'}
                </button>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={stripImages} onChange={e => setStripImages(e.target.checked)} />
                  Strip images
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={saveHistory} onChange={e => setSaveHistory(e.target.checked)} />
                  Save to history
                </label>
              </div>
              {error && (
                <div className="rounded border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
            </div>
          </PluginSection>

          {result && (
            <>
              <PluginSection title="Article">
                <div className="grid gap-3 md:grid-cols-[1fr_280px]">
                  <PluginCard>
                    <div className="mb-2 flex items-center gap-2 border-b pb-2">
                      {(['rendered', 'raw', 'metadata'] as const).map(p => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPreview(p)}
                          className={`rounded px-2 py-0.5 text-xs ${preview === p ? 'bg-accent' : 'hover:bg-accent'}`}
                        >
                          {p}
                        </button>
                      ))}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {result.length.toLocaleString()} chars · {formatBytes(result.bytes)} · {result.duration_ms}ms
                      </span>
                    </div>

                    {preview === 'rendered' && (
                      <div className="max-h-[70vh] overflow-auto">
                        <h2 className="mb-1 text-lg font-semibold">{result.title ?? '(untitled)'}</h2>
                        {result.byline && <div className="mb-3 text-xs text-muted-foreground">by {result.byline}{result.published_time ? ` · ${result.published_time}` : ''}</div>}
                        {result.lead_image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={result.lead_image} alt="" className="mb-3 max-h-64 w-auto rounded" />
                        )}
                        <div
                          className="prose prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: previewHtml ?? '' }}
                        />
                      </div>
                    )}

                    {preview === 'raw' && (
                      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs font-mono">
                        {result.content ?? '(empty)'}
                      </pre>
                    )}

                    {preview === 'metadata' && (
                      <pre className="max-h-[70vh] overflow-auto rounded bg-muted p-3 text-xs font-mono">
                        {JSON.stringify({ result, metadata }, null, 2)}
                      </pre>
                    )}
                  </PluginCard>

                  <PluginCard>
                    <div className="text-xs text-muted-foreground">Summary</div>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">URL</dt>
                      <dd className="truncate font-mono" title={result.url}>{result.url}</dd>
                      {result.final_url !== result.url && (
                        <>
                          <dt className="text-muted-foreground">Final</dt>
                          <dd className="truncate font-mono" title={result.final_url}>{result.final_url}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Status</dt>
                      <dd className="font-mono">{result.status}</dd>
                      {result.site_name && (<><dt className="text-muted-foreground">Site</dt><dd>{result.site_name}</dd></>)}
                      {result.author && (<><dt className="text-muted-foreground">Author</dt><dd>{result.author}</dd></>)}
                      {result.published_time && (<><dt className="text-muted-foreground">Published</dt><dd>{result.published_time}</dd></>)}
                      {result.lang && (<><dt className="text-muted-foreground">Lang</dt><dd>{result.lang}</dd></>)}
                      <dt className="text-muted-foreground">Readerable</dt>
                      <dd>{result.probably_readerable ? 'yes' : 'no'}</dd>
                    </dl>
                    {result.excerpt && (
                      <>
                        <div className="mt-3 text-xs text-muted-foreground">Excerpt</div>
                        <p className="mt-1 text-xs leading-relaxed">{result.excerpt}</p>
                      </>
                    )}
                  </PluginCard>
                </div>
              </PluginSection>
            </>
          )}
        </>
      )}

      {tab === 'history' && (
        <PluginSection
          title="Fetch history"
          description="Last 200 fetches for this project. Click a row to replay in the playground."
        >
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={handleClearHistory}
              disabled={!historyQ.data || historyQ.data.entries.length === 0}
              className="rounded border px-3 py-1 text-xs hover:bg-accent disabled:opacity-40"
            >
              Clear all
            </button>
          </div>
          {historyQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (historyQ.data?.entries.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No fetches yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {historyQ.data!.entries.map(e => (
                <li key={e.id} className="rounded border p-3 text-xs hover:bg-accent/30">
                  <div className="flex items-start gap-3">
                    {e.leadImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={e.leadImage} alt="" className="h-16 w-20 flex-shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-16 w-20 flex-shrink-0 items-center justify-center rounded border text-muted-foreground">—</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => { setTab('playground'); handleRead(e.url) }}
                        className="block truncate text-left font-medium hover:underline"
                        title={e.title ?? e.url}
                      >
                        {e.title ?? e.url}
                      </button>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={e.finalUrl}>
                        {e.siteName ? `${e.siteName} · ` : ''}{e.finalUrl}
                      </div>
                      {e.excerpt && <p className="mt-1 line-clamp-2 text-muted-foreground">{e.excerpt}</p>}
                      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                        <span>{timeAgo(e.fetchedAt)}</span>
                        <span>{e.length.toLocaleString()} chars</span>
                        <span>{formatBytes(e.bytes)}</span>
                        <span>{e.durationMs}ms</span>
                        {e.author && <span>by {e.author}</span>}
                        {e.error && <span className="text-destructive">error: {e.error}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteEntry(e.id)}
                      className="flex-shrink-0 rounded border px-2 py-1 text-[11px] hover:bg-accent"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PluginSection>
      )}

      {tab === 'settings' && (
        <PluginSection
          title="Plugin defaults"
          description="These values are used by the agent tools and the playground when not overridden per-call. Project-level overrides go through the standard plugin config flow in Project Settings."
        >
          {configQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !configQ.data ? (
            <p className="text-sm text-muted-foreground">Config unavailable.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <PluginCard>
                <div className="text-xs text-muted-foreground">User-Agent strategy</div>
                <div className="mt-1 text-sm">
                  {configQ.data.config.user_agent
                    ? <>Fixed: <span className="font-mono text-xs">{configQ.data.config.user_agent}</span></>
                    : 'Rotate realistic Chrome / Firefox / Safari desktop profiles'}
                </div>
              </PluginCard>
              <PluginCard>
                <div className="text-xs text-muted-foreground">Timeout</div>
                <div className="mt-1 font-mono text-sm">{configQ.data.config.timeout_ms} ms</div>
              </PluginCard>
              <PluginCard>
                <div className="text-xs text-muted-foreground">Max response size</div>
                <div className="mt-1 font-mono text-sm">{formatBytes(configQ.data.config.max_bytes)}</div>
              </PluginCard>
              <PluginCard>
                <div className="text-xs text-muted-foreground">Default output format</div>
                <div className="mt-1 font-mono text-sm">{configQ.data.config.default_format}</div>
              </PluginCard>
              <PluginCard>
                <div className="text-xs text-muted-foreground">Strip images</div>
                <div className="mt-1 font-mono text-sm">{configQ.data.config.strip_images ? 'yes' : 'no'}</div>
              </PluginCard>
              <PluginCard>
                <div className="text-xs text-muted-foreground">Private networks</div>
                <div className={`mt-1 font-mono text-sm ${configQ.data.config.allow_private_networks ? 'text-destructive' : ''}`}>
                  {configQ.data.config.allow_private_networks ? 'ALLOWED (SSRF guard disabled)' : 'blocked (SSRF guard on)'}
                </div>
              </PluginCard>
            </div>
          )}
        </PluginSection>
      )}
    </PluginPage>
  )
}

export default defineMountable(WebReaderPanel)
