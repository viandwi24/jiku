import { BrowserAdapter } from '@jiku/kit'
import type {
  BrowserAdapterContext,
  BrowserAdapterResult,
  BrowserPingResult,
  BrowserPreviewResult,
  BrowserCustomAction,
} from '@jiku/kit'
import { z } from 'zod'
import { CamofoxConfigSchema, type CamofoxConfig } from './types.ts'

// CamoFox speaks REST, not CDP. This adapter implements a thin HTTP client
// against its documented endpoints:
//   https://github.com/jo-inc/camofox-browser
//
// Session model: userId (per profile) → sessionKey (per agent) → tabId.
// We track (profileId, agentId) → tabId in-memory so every agent gets its
// own isolated tab. CamoFox itself handles concurrency per tab, so no
// additional mutex is required.

interface CamofoxSession {
  userId: string
  sessionKey: string
}

type AgentTabs = Map<string, string>        // agentId → tabId
const tabsByProfile = new Map<string, AgentTabs>()   // profileId → (agentId → tabId)
const PREVIEW_AGENT_ID = '__preview__'

function resolveBaseUrl(cfg: CamofoxConfig): string {
  const u = (cfg.base_url ?? 'http://localhost:9377').trim()
  return u.replace(/\/$/, '')
}

function resolveSession(profileId: string, agentId: string, cfg: CamofoxConfig): CamofoxSession {
  return {
    userId: cfg.user_id?.trim() || profileId,
    sessionKey: agentId,
  }
}

function authHeaders(cfg: CamofoxConfig): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.api_key) h['authorization'] = `Bearer ${cfg.api_key}`
  return h
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cfg: CamofoxConfig,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeout_ms ?? 30_000)
  try {
    const res = await fetch(url, {
      method,
      headers: authHeaders(cfg),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    const parsed: unknown = text ? safeJson(text) : null
    if (!res.ok) {
      const msg = extractErrorMessage(parsed) ?? text ?? `HTTP ${res.status}`
      throw new Error(`CamoFox ${method} ${stripBase(url)} → ${res.status}: ${msg}`)
    }
    return parsed as T
  } finally {
    clearTimeout(timeout)
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

function stripBase(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '')
}

function extractErrorMessage(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (typeof obj['error'] === 'string') return obj['error']
    if (typeof obj['message'] === 'string') return obj['message']
  }
  return null
}

/**
 * Fetch a binary image endpoint (e.g. /tabs/:id/screenshot which returns
 * raw `image/png` bytes, not JSON) and return base64 + format.
 */
async function requestImage(
  url: string,
  cfg: CamofoxConfig,
): Promise<{ base64: string; format: 'png' | 'jpeg' }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeout_ms ?? 30_000)
  try {
    const res = await fetch(url, { method: 'GET', headers: authHeaders(cfg), signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`CamoFox GET ${stripBase(url)} → ${res.status}: ${text || 'HTTP error'}`)
    }
    const contentType = res.headers.get('content-type') ?? ''
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('CamoFox screenshot returned 0 bytes')
    const format: 'png' | 'jpeg' = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpeg' : 'png'
    return { base64: Buffer.from(bytes).toString('base64'), format }
  } finally {
    clearTimeout(timeout)
  }
}

interface CreateTabResponse {
  id?: string
  tabId?: string
  tab_id?: string
}

async function getOrCreateTab(
  base: string,
  cfg: CamofoxConfig,
  profileId: string,
  agentId: string,
  initialUrl?: string,
): Promise<string> {
  let agentMap = tabsByProfile.get(profileId)
  if (!agentMap) {
    agentMap = new Map()
    tabsByProfile.set(profileId, agentMap)
  }
  const existing = agentMap.get(agentId)
  if (existing) return existing

  const session = resolveSession(profileId, agentId, cfg)
  const body = {
    userId: session.userId,
    sessionKey: session.sessionKey,
    ...(initialUrl ? { url: initialUrl } : {}),
  }
  const created = await request<CreateTabResponse>('POST', `${base}/tabs`, cfg, body)
  const tabId = created.id ?? created.tabId ?? created.tab_id
  if (!tabId) {
    throw new Error(`CamoFox POST /tabs returned no tab id (response: ${JSON.stringify(created)})`)
  }
  agentMap.set(agentId, tabId)
  return tabId
}

function forgetTab(profileId: string, agentId: string): void {
  const map = tabsByProfile.get(profileId)
  if (!map) return
  map.delete(agentId)
  if (map.size === 0) tabsByProfile.delete(profileId)
}

// ─────────────────────────────────────────────────────────────────────────────

interface ActionArgs {
  action: string
  url?: string
  ref?: string
  text?: string
  key?: string
  direction?: string
  selector?: string
  ms?: number
  full?: boolean
  annotate?: boolean
  includeScreenshot?: boolean
  subcommand?: string
  pressEnter?: boolean
}

const UNSUPPORTED_ACTIONS: Record<string, string> = {
  pdf: 'PDF export is not supported by CamoFox.',
  eval: 'JavaScript eval is not supported by CamoFox (no /eval endpoint).',
  cookies_get: 'Reading cookies via tool is not supported; use sessions/:userId/cookies server-side.',
  cookies_set: 'Setting cookies via tool is not supported; POST /sessions/:userId/cookies on the CamoFox server directly.',
  cookies_clear: 'Clearing cookies is not supported.',
  storage: 'Web storage access is not supported by CamoFox.',
  batch: 'Batch commands are not supported by CamoFox.',
  drag: 'Drag is not supported by CamoFox.',
  upload: 'File upload is not supported by CamoFox.',
  dblclick: 'Double-click is not supported by CamoFox.',
  hover: 'Hover is not supported by CamoFox.',
  focus: 'Focus is not supported by CamoFox.',
  check: 'Checkbox check is not supported by CamoFox — use click with the checkbox ref.',
  uncheck: 'Checkbox uncheck is not supported by CamoFox — use click with the checkbox ref.',
  select: 'Select element interaction is not supported by CamoFox.',
  scrollintoview: 'scrollintoview is not supported by CamoFox — use scroll with a direction.',
}

export class CamofoxAdapter extends BrowserAdapter {
  readonly id = 'jiku.camofox'
  readonly displayName = 'CamoFox'
  readonly description = [
    'Firefox-based browser with advanced anti-fingerprinting. Ideal for workflows',
    'that need to bypass bot detection or simulate realistic human browsing.',
    'Powered by CamoFox (jo-inc/camofox-browser) via its REST API on port 9377.',
    'Start the CamoFox container (see infra/dokploy/docker-compose.browser.yml)',
    'and point base_url at it. Each Studio profile becomes one CamoFox userId;',
    'each agent in the profile gets its own tab automatically.',
  ].join(' ')
  readonly configSchema = CamofoxConfigSchema

  async execute(input: unknown, ctx: BrowserAdapterContext): Promise<BrowserAdapterResult> {
    const args = (input ?? {}) as ActionArgs
    const cfg = (ctx.config ?? {}) as CamofoxConfig
    const base = resolveBaseUrl(cfg)
    const agentId = ctx.agentId ?? 'default-agent'
    const action = args.action

    if (!action) throw new Error('CamoFox: missing `action` field')

    // Reserved and unsupported.
    if (action === 'tab_new' || action === 'tab_close' || action === 'tab_switch' || action === 'tab_list' || action === 'close') {
      throw new Error(`Browser action '${action}' is reserved by Studio and not exposed to CamoFox.`)
    }
    if (UNSUPPORTED_ACTIONS[action]) {
      throw new Error(`CamoFox: ${UNSUPPORTED_ACTIONS[action]}`)
    }

    const session = resolveSession(ctx.profileId, agentId, cfg)

    switch (action) {
      case 'open': {
        if (!args.url) throw new Error("CamoFox 'open' requires `url`.")
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId, args.url)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/navigate`, cfg, {
          userId: session.userId,
          url: args.url,
        })
        return textResult({ ok: true, tabId, action: 'open', url: args.url, details: res })
      }

      case 'back': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/back`, cfg, { userId: session.userId })
        return textResult({ ok: true, action: 'back', details: res })
      }
      case 'forward': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/forward`, cfg, { userId: session.userId })
        return textResult({ ok: true, action: 'forward', details: res })
      }
      case 'reload': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/refresh`, cfg, { userId: session.userId })
        return textResult({ ok: true, action: 'reload', details: res })
      }

      case 'snapshot': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const qs = new URLSearchParams({ userId: session.userId })
        const snap = await request<unknown>('GET', `${base}/tabs/${tabId}/snapshot?${qs.toString()}`, cfg)
        return textResult(snap)
      }

      case 'screenshot': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const qs = new URLSearchParams({ userId: session.userId })
        const { base64, format } = await requestImage(`${base}/tabs/${tabId}/screenshot?${qs.toString()}`, cfg)
        return {
          content: [
            { type: 'image', data: base64, mimeType: `image/${format}` },
          ],
        }
      }

      case 'click': {
        if (!args.ref) throw new Error("CamoFox 'click' requires `ref`.")
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/click`, cfg, {
          userId: session.userId,
          ref: args.ref,
        })
        return textResult(res)
      }

      case 'fill':
      case 'type': {
        if (!args.ref) throw new Error(`CamoFox '${action}' requires \`ref\`.`)
        if (args.text === undefined) throw new Error(`CamoFox '${action}' requires \`text\`.`)
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/type`, cfg, {
          userId: session.userId,
          ref: args.ref,
          text: args.text,
          pressEnter: Boolean(args.pressEnter ?? false),
        })
        return textResult(res)
      }

      case 'press': {
        if (!args.key) throw new Error("CamoFox 'press' requires `key`.")
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/press`, cfg, {
          userId: session.userId,
          key: args.key,
        })
        return textResult(res)
      }

      case 'scroll': {
        if (!args.direction) throw new Error("CamoFox 'scroll' requires `direction`.")
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/scroll`, cfg, {
          userId: session.userId,
          direction: args.direction,
        })
        return textResult(res)
      }

      case 'wait': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/wait`, cfg, {
          userId: session.userId,
          ...(args.selector && { selector: args.selector }),
          ...(args.ms !== undefined && { timeout: args.ms }),
        })
        return textResult(res)
      }

      case 'get': {
        // CamoFox exposes title/url only via the snapshot payload. For other
        // subcommands we delegate to snapshot and let the caller extract.
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const qs = new URLSearchParams({ userId: session.userId })
        const snap = await request<Record<string, unknown>>(
          'GET', `${base}/tabs/${tabId}/snapshot?${qs.toString()}`, cfg,
        )
        if (args.subcommand === 'url') return textResult({ url: snap['url'] ?? null })
        if (args.subcommand === 'title') return textResult({ title: snap['title'] ?? null })
        return textResult({ snapshot: snap })
      }

      default:
        throw new Error(`CamoFox: unsupported action '${action}'.`)
    }
  }

  async ping(config: unknown): Promise<BrowserPingResult> {
    const cfg = CamofoxConfigSchema.parse(config ?? {})
    const base = resolveBaseUrl(cfg)
    const start = Date.now()
    const controller = new AbortController()
    const to = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`${base}/health`, { headers: authHeaders(cfg), signal: controller.signal })
      const latency = Date.now() - start
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latency_ms: latency, cdp_url: base }
      return { ok: true, latency_ms: latency, browser: 'CamoFox (Firefox)', cdp_url: base }
    } catch (err) {
      return {
        ok: false,
        error: `Cannot reach CamoFox at ${base} — ${err instanceof Error ? err.message : String(err)}`,
        cdp_url: base,
      }
    } finally {
      clearTimeout(to)
    }
  }

  async preview(config: unknown): Promise<BrowserPreviewResult> {
    const cfg = CamofoxConfigSchema.parse(config ?? {})
    const base = resolveBaseUrl(cfg)
    try {
      // Use a dedicated preview tab per profile so we never steal focus from
      // an agent. Reuses the same tab-tracking map.
      const profileId = cfg.user_id?.trim() || '__preview_profile__'
      // CamoFox rejects non-http(s) schemes (including about:blank). Use the
      // configured preview landing URL so the tab actually loads something
      // the user can visually verify.
      const landingUrl = cfg.preview_url?.trim() || 'https://www.example.com'
      const tabId = await getOrCreateTab(base, cfg, profileId, PREVIEW_AGENT_ID, landingUrl)
      const session = resolveSession(profileId, PREVIEW_AGENT_ID, cfg)
      const qs = new URLSearchParams({ userId: session.userId })
      const { base64, format } = await requestImage(`${base}/tabs/${tabId}/screenshot?${qs.toString()}`, cfg)
      // CamoFox's /screenshot is raw PNG only — it does not include title/url.
      // Pull those from a snapshot call as best-effort (skip on failure so the
      // preview still renders even if the snapshot endpoint hiccups).
      let title: string | undefined
      let urlPath: string | undefined
      try {
        const snap = await request<{ title?: string; url?: string }>(
          'GET', `${base}/tabs/${tabId}/snapshot?${qs.toString()}`, cfg,
        )
        title = snap.title
        urlPath = snap.url
      } catch { /* best-effort */ }
      return {
        ok: true,
        data: {
          base64,
          format,
          ...(title && { title }),
          ...(urlPath && { url: urlPath }),
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  override async onProfileDeactivated(profileId: string): Promise<void> {
    tabsByProfile.delete(profileId)
  }

  // ─── Custom actions (platform-specific) ─────────────────────────────────
  // Discoverable via `browser_list_actions`, invoked via `browser_run_action`.
  // Mirrors CamoFox's non-core endpoints so LLMs can use anti-fingerprint
  // features without bloating the unified `browser` tool's action enum.

  readonly customActions: readonly BrowserCustomAction[] = CAMOFOX_CUSTOM_ACTIONS

  override async runCustomAction(
    actionId: string,
    params: unknown,
    ctx: BrowserAdapterContext,
  ): Promise<BrowserAdapterResult> {
    const cfg = (ctx.config ?? {}) as CamofoxConfig
    const base = resolveBaseUrl(cfg)
    const agentId = ctx.agentId ?? 'default-agent'
    const p = (params ?? {}) as Record<string, unknown>

    switch (actionId) {
      case 'youtube_transcript': {
        const url = typeof p['url'] === 'string' ? p['url'] : ''
        if (!url) throw new Error("youtube_transcript requires `url`.")
        const langs = Array.isArray(p['languages']) ? p['languages'] as string[] : ['en']
        const res = await request<unknown>('POST', `${base}/youtube/transcript`, cfg, {
          url, languages: langs,
        })
        return textResult(res)
      }

      case 'links': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const session = resolveSession(ctx.profileId, agentId, cfg)
        const qs = new URLSearchParams({ userId: session.userId })
        const res = await request<unknown>('GET', `${base}/tabs/${tabId}/links?${qs.toString()}`, cfg)
        return textResult(res)
      }

      case 'images': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const session = resolveSession(ctx.profileId, agentId, cfg)
        const qs = new URLSearchParams({ userId: session.userId })
        if (p['includeData'] === true) qs.set('includeData', 'true')
        if (typeof p['maxBytes'] === 'number') qs.set('maxBytes', String(p['maxBytes']))
        if (typeof p['limit'] === 'number') qs.set('limit', String(p['limit']))
        const res = await request<unknown>('GET', `${base}/tabs/${tabId}/images?${qs.toString()}`, cfg)
        return textResult(res)
      }

      case 'downloads': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const session = resolveSession(ctx.profileId, agentId, cfg)
        const qs = new URLSearchParams({ userId: session.userId })
        if (p['includeData'] === true) qs.set('includeData', 'true')
        if (p['consume'] === true) qs.set('consume', 'true')
        if (typeof p['maxBytes'] === 'number') qs.set('maxBytes', String(p['maxBytes']))
        const res = await request<unknown>('GET', `${base}/tabs/${tabId}/downloads?${qs.toString()}`, cfg)
        return textResult(res)
      }

      case 'macro': {
        const macro = typeof p['macro'] === 'string' ? p['macro'] : ''
        const query = typeof p['query'] === 'string' ? p['query'] : ''
        if (!macro) throw new Error("macro requires `macro` (e.g. 'google_search').")
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const session = resolveSession(ctx.profileId, agentId, cfg)
        const res = await request<unknown>('POST', `${base}/tabs/${tabId}/navigate`, cfg, {
          userId: session.userId,
          macro,
          ...(query && { query }),
        })
        return textResult(res)
      }

      case 'stats': {
        const tabId = await getOrCreateTab(base, cfg, ctx.profileId, agentId)
        const res = await request<unknown>('GET', `${base}/tabs/${tabId}/stats`, cfg)
        return textResult(res)
      }

      case 'import_cookies': {
        const cookies = Array.isArray(p['cookies']) ? p['cookies'] : null
        if (!cookies) throw new Error("import_cookies requires `cookies` (array of Playwright cookie objects).")
        const session = resolveSession(ctx.profileId, agentId, cfg)
        const res = await request<unknown>(
          'POST', `${base}/sessions/${encodeURIComponent(session.userId)}/cookies`, cfg, { cookies },
        )
        return textResult(res)
      }

      default:
        throw new Error(`CamoFox: unknown custom action '${actionId}'.`)
    }
  }
}

// ─── Custom action registry ──────────────────────────────────────────────────

const YoutubeTranscriptParams = z.object({
  url: z.string().describe('YouTube video URL (https://www.youtube.com/watch?v=...).'),
  languages: z.array(z.string()).optional()
    .describe('Preferred transcript languages in priority order (default: ["en"]).'),
})

const LinksParams = z.object({}).describe('No parameters required — returns all links on the current tab.')

const ImagesParams = z.object({
  includeData: z.boolean().optional()
    .describe('Include raw image bytes as base64 in the response. Default: false (returns src/alt only).'),
  maxBytes: z.number().int().optional()
    .describe('Skip images larger than this many bytes when includeData=true.'),
  limit: z.number().int().optional()
    .describe('Maximum number of images to return.'),
})

const DownloadsParams = z.object({
  includeData: z.boolean().optional()
    .describe('Include raw download bytes as base64 in the response.'),
  consume: z.boolean().optional()
    .describe('Delete downloads from CamoFox after returning them. Default: false.'),
  maxBytes: z.number().int().optional()
    .describe('Skip downloads larger than this many bytes.'),
})

const MacroParams = z.object({
  macro: z.string().describe('Macro id exposed by CamoFox (e.g. "google_search", "amazon_search").'),
  query: z.string().optional().describe('Query string passed to the macro.'),
})

const StatsParams = z.object({}).describe('No parameters — returns tool-call counts and visited URLs.')

const ImportCookiesParams = z.object({
  cookies: z.array(z.record(z.string(), z.unknown()))
    .describe('Playwright-compatible cookie objects (name, value, domain, path, expires, httpOnly, secure, sameSite).'),
})

const CAMOFOX_CUSTOM_ACTIONS: readonly BrowserCustomAction[] = [
  {
    id: 'youtube_transcript',
    displayName: 'YouTube transcript',
    description: 'Fetch the transcript of a YouTube video with optional language preferences.',
    inputSchema: YoutubeTranscriptParams,
    example: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', languages: ['en'] },
  },
  {
    id: 'links',
    displayName: 'List page links',
    description: 'Return every link (<a href>) on the current tab, useful for crawl/discovery.',
    inputSchema: LinksParams,
  },
  {
    id: 'images',
    displayName: 'List page images',
    description: 'Return images on the current tab. Set includeData=true to get bytes as base64.',
    inputSchema: ImagesParams,
    example: { includeData: false, limit: 50 },
  },
  {
    id: 'downloads',
    displayName: 'Captured downloads',
    description: 'List (and optionally consume) files the browser has downloaded during the session.',
    inputSchema: DownloadsParams,
  },
  {
    id: 'macro',
    displayName: 'Run navigation macro',
    description: 'Invoke a CamoFox-defined navigation macro (e.g. google_search) with an optional query.',
    inputSchema: MacroParams,
    example: { macro: 'google_search', query: 'anthropic claude' },
  },
  {
    id: 'stats',
    displayName: 'Tab stats',
    description: 'Return counters and visited URLs for the current tab — useful for debugging.',
    inputSchema: StatsParams,
  },
  {
    id: 'import_cookies',
    displayName: 'Import cookies',
    description: 'Inject Playwright-style cookies into this profile\'s CamoFox session.',
    inputSchema: ImportCookiesParams,
  },
] as const

function textResult(obj: unknown): BrowserAdapterResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] }
}

// Re-exported so manager/profile deactivation paths can clean up.
export function forgetCamofoxAgentTab(profileId: string, agentId: string): void {
  forgetTab(profileId, agentId)
}

export const camofoxAdapter = new CamofoxAdapter()
