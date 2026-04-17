// jiku.web-reader — URL → reader-mode article extractor.
//
// Server-side:
//   • Registers `web_read`, `web_fetch_metadata`, `web_read_many` tools that
//     agents can call to pull clean article content from public URLs.
//   • Registers HTTP routes under /api/plugins/jiku.web-reader/api/* for the
//     Studio UI panel (test playground + history browser + settings).
//   • Persists fetch history in ctx.storage (KV) per project, capped at 200
//     entries. No DB migration required.
//
// Reader pipeline: linkedom → strip noise → @mozilla/readability → turndown
// for Markdown output. SSRF guard + response-size cap live in fetcher.ts.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin, defineTool } from '@jiku/kit'
import { defineUI } from '@jiku/kit/ui'
import { StudioPlugin } from '@jiku-plugin/studio'
import { z } from 'zod'
import { fetchUrl, type FetchOptions } from './fetcher.ts'
import { parseReader } from './reader.ts'
import { htmlToMarkdown } from './markdown.ts'
import { appendHistory, clearHistory, deleteHistoryEntry, listHistory } from './history.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UI_DIST_DIR = join(__dirname, '..', 'dist', 'ui')

const configSchema = z.object({
  user_agent: z.string().optional().describe('Override User-Agent string. Leave empty to rotate across realistic Chrome/Firefox/Safari profiles.'),
  timeout_ms: z.number().int().min(1000).max(60_000).default(15_000).describe('Per-request timeout in milliseconds'),
  max_bytes: z.number().int().min(10_000).max(20 * 1024 * 1024).default(2 * 1024 * 1024).describe('Maximum response size in bytes (hard cap to avoid OOM)'),
  default_format: z.enum(['markdown', 'html', 'text']).default('markdown').describe('Default output format when the tool caller does not specify one'),
  strip_images: z.boolean().default(false).describe('Remove images from Markdown output to save tokens'),
  allow_private_networks: z.boolean().default(false).describe('DANGEROUS: allow fetching localhost / RFC1918 / link-local addresses. Only enable for internal testing.'),
})

type WebReaderConfig = z.infer<typeof configSchema>

interface ReadOutput {
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

function stripMarkdownImages(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

async function runRead(
  url: string,
  format: 'markdown' | 'html' | 'text',
  fetchOpts: FetchOptions,
  stripImages: boolean,
): Promise<{ output: ReadOutput; article: ReturnType<typeof parseReader>['article']; metadata: ReturnType<typeof parseReader>['metadata'] }> {
  const started = Date.now()
  const res = await fetchUrl(url, fetchOpts)
  const { article, metadata } = parseReader(res.html, res.finalUrl)

  let content: string | null = null
  if (format === 'html') {
    content = article.contentHtml
  } else if (format === 'text') {
    content = article.textContent
  } else {
    const md = article.contentHtml ? htmlToMarkdown(article.contentHtml) : null
    content = md && stripImages ? stripMarkdownImages(md) : md
  }

  const output: ReadOutput = {
    url,
    final_url: res.finalUrl,
    status: res.status,
    title: article.title,
    byline: article.byline,
    excerpt: article.excerpt,
    site_name: article.siteName,
    published_time: article.publishedTime,
    author: metadata.author ?? article.byline,
    lead_image: metadata.leadImage ?? null,
    lang: article.lang,
    length: article.length,
    content,
    format,
    probably_readerable: article.probablyReaderable,
    duration_ms: Date.now() - started,
    bytes: res.byteLength,
  }
  return { output, article, metadata }
}

function resolveFetchOpts(cfg: Partial<WebReaderConfig> | undefined): FetchOptions {
  return {
    timeoutMs: cfg?.timeout_ms ?? 15_000,
    maxBytes: cfg?.max_bytes ?? 2 * 1024 * 1024,
    userAgent: cfg?.user_agent,
    allowPrivateNetworks: cfg?.allow_private_networks ?? false,
  }
}

export default definePlugin({
  meta: {
    id: 'jiku.web-reader',
    name: 'Web Reader',
    version: '1.0.0',
    description: 'Scrape any public URL and return a clean reader-mode article (title, byline, content as Markdown, images, metadata) — powered by @mozilla/readability + linkedom.',
    author: 'Jiku',
    icon: '🌐',
    category: 'productivity',
    project_scope: true,
  },

  depends: [StudioPlugin],

  configSchema,

  ui: defineUI({
    assetsDir: UI_DIST_DIR,
    entries: [
      {
        slot: 'project.page',
        id: 'panel',
        module: './WebReaderPanel.js',
        meta: { path: '', title: 'Web Reader', icon: 'BookOpen' },
      },
      {
        slot: 'project.settings.section',
        id: 'settings',
        module: './WebReaderPanel.js',
        meta: { label: 'Web Reader', icon: 'BookOpen', order: 60 },
      },
    ],
  }),

  setup(ctx) {
    // Plugin-level default config snapshot. Per-project config is available
    // inside tools via `toolCtx.config` and inside project plugin lifecycle
    // hooks via `ctx.config`. For the HTTP panel we keep behaviour driven by
    // the request body (see POST /read below) so the UI playground can
    // override settings without persisting them.
    const defaults: WebReaderConfig = configSchema.parse({})

    // ─── HTTP routes (panel) ───────────────────────────────────────────────
    // POST /read   { url, format?, user_agent?, timeout_ms?, max_bytes?, strip_images?, allow_private_networks? }
    // GET  /history
    // DELETE /history
    // DELETE /history/:id
    // GET  /config   (returns current defaults)

    ctx.http.post('/read', async ({ projectId, req }) => {
      const body = (req.body ?? {}) as {
        url?: string
        format?: 'markdown' | 'html' | 'text'
        user_agent?: string
        timeout_ms?: number
        max_bytes?: number
        strip_images?: boolean
        allow_private_networks?: boolean
        save_history?: boolean
      }

      if (!body.url || typeof body.url !== 'string') {
        return { ok: false, error: 'url is required' }
      }

      const format = body.format ?? defaults.default_format
      const stripImages = body.strip_images ?? defaults.strip_images
      const fetchOpts: FetchOptions = {
        timeoutMs: body.timeout_ms ?? defaults.timeout_ms,
        maxBytes: body.max_bytes ?? defaults.max_bytes,
        userAgent: body.user_agent ?? defaults.user_agent,
        allowPrivateNetworks: body.allow_private_networks ?? defaults.allow_private_networks,
      }

      const started = Date.now()
      try {
        const { output, article, metadata } = await runRead(body.url, format, fetchOpts, stripImages)
        if (body.save_history !== false) {
          await appendHistory(ctx.storage, projectId, {
            url: body.url,
            finalUrl: output.final_url,
            status: output.status,
            durationMs: output.duration_ms,
            bytes: output.bytes,
            length: output.length,
            article: { title: article.title, byline: article.byline, excerpt: article.excerpt, siteName: article.siteName },
            metadata: { leadImage: metadata.leadImage },
          })
        }
        return { ok: true, result: output, metadata }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (body.save_history !== false) {
          await appendHistory(ctx.storage, projectId, {
            url: body.url,
            finalUrl: body.url,
            status: 0,
            durationMs: Date.now() - started,
            bytes: 0,
            length: 0,
            article: { title: null, byline: null, excerpt: null, siteName: null },
            metadata: { leadImage: undefined },
            error: message,
          })
        }
        return { ok: false, error: message }
      }
    })

    ctx.http.get('/history', async ({ projectId }) => {
      const entries = await listHistory(ctx.storage, projectId)
      return { entries }
    })

    ctx.http.delete('/history', async ({ projectId }) => {
      await clearHistory(ctx.storage, projectId)
      return { ok: true }
    })

    ctx.http.delete('/history/:id', async ({ projectId, req }) => {
      const id = (req.params as Record<string, string | string[]>)['id']
      const single = Array.isArray(id) ? id[0] : id
      if (!single) return { ok: false, error: 'id required' }
      await deleteHistoryEntry(ctx.storage, projectId, single)
      return { ok: true }
    })

    ctx.http.get('/config', async () => ({ config: defaults }))

    // ─── Tools ─────────────────────────────────────────────────────────────

    ctx.project.tools.register(
      defineTool({
        meta: {
          id: 'web_read',
          name: 'Web Read',
          group: 'web',
          description: 'Fetch a public URL and return a clean reader-mode article (title, byline, content as Markdown/HTML/text, lead image, publish date). Use for news articles, blog posts, docs. Returns structured fields — do NOT paste the raw content back to the user unless asked; use it as input for further reasoning.',
        },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({
          url: z.string().url().describe('Public HTTP(S) URL to fetch'),
          format: z.enum(['markdown', 'html', 'text']).optional().describe('Output format for `content` field. Defaults to plugin config.'),
          strip_images: z.boolean().optional().describe('Remove images from Markdown output (saves tokens)'),
        }),
        execute: async (args, toolCtx) => {
          const input = args as { url: string; format?: 'markdown' | 'html' | 'text'; strip_images?: boolean }
          const format = input.format ?? defaults.default_format
          const stripImages = input.strip_images ?? defaults.strip_images
          const fetchOpts = resolveFetchOpts(defaults)
          // Runner injects project_id directly into RuntimeContext. The older
          // `caller.user_data.project_id` path was never populated by
          // `resolveCaller` — always undefined → history never written for
          // tool-invoked runs (only the playground/HTTP path worked because
          // it reads projectId from the plugin ctx closure, not the tool).
          const projectId = toolCtx.runtime['project_id'] as string | undefined
          const started = Date.now()
          try {
            const { output, article, metadata } = await runRead(input.url, format, fetchOpts, stripImages)
            if (projectId) {
              await appendHistory(toolCtx.storage, projectId, {
                url: input.url,
                finalUrl: output.final_url,
                status: output.status,
                durationMs: output.duration_ms,
                bytes: output.bytes,
                length: output.length,
                article: { title: article.title, byline: article.byline, excerpt: article.excerpt, siteName: article.siteName },
                metadata: { leadImage: metadata.leadImage },
              })
            }
            return output
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            if (projectId) {
              await appendHistory(toolCtx.storage, projectId, {
                url: input.url,
                finalUrl: input.url,
                status: 0,
                durationMs: Date.now() - started,
                bytes: 0,
                length: 0,
                article: { title: null, byline: null, excerpt: null, siteName: null },
                metadata: { leadImage: undefined },
                error: message,
              })
            }
            throw new Error(`web_read failed: ${message}`)
          }
        },
      }),

      defineTool({
        meta: {
          id: 'web_fetch_metadata',
          name: 'Web Fetch Metadata',
          group: 'web',
          description: 'Cheap metadata-only fetch for a URL (title, description, og:image, author, site_name). Use this to preview a link without paying the cost of full article extraction.',
        },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({
          url: z.string().url().describe('Public HTTP(S) URL'),
        }),
        execute: async (args, _toolCtx) => {
          const input = args as { url: string }
          const fetchOpts = resolveFetchOpts(defaults)
          const res = await fetchUrl(input.url, fetchOpts)
          const { metadata } = parseReader(res.html, res.finalUrl)
          return {
            url: input.url,
            final_url: res.finalUrl,
            status: res.status,
            title: metadata.title ?? null,
            description: metadata.description ?? null,
            site_name: metadata.siteName ?? null,
            author: metadata.author ?? null,
            published_time: metadata.publishedTime ?? null,
            lead_image: metadata.leadImage ?? null,
            canonical_url: metadata.canonicalUrl ?? null,
            og_type: metadata.ogType ?? null,
            lang: metadata.lang ?? null,
          }
        },
      }),

      defineTool({
        meta: {
          id: 'web_read_many',
          name: 'Web Read Many',
          group: 'web',
          description: 'Batch-read up to 10 URLs in parallel (concurrency 3). Returns per-URL results with errors isolated. Use for multi-source research.',
        },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({
          urls: z.array(z.string().url()).min(1).max(10).describe('List of URLs to fetch (max 10)'),
          format: z.enum(['markdown', 'html', 'text']).optional(),
          strip_images: z.boolean().optional(),
        }),
        execute: async (args, _toolCtx) => {
          const input = args as { urls: string[]; format?: 'markdown' | 'html' | 'text'; strip_images?: boolean }
          const format = input.format ?? defaults.default_format
          const stripImages = input.strip_images ?? defaults.strip_images
          const fetchOpts = resolveFetchOpts(defaults)

          const CONCURRENCY = 3
          const results: Array<{ url: string; ok: boolean; result?: ReadOutput; error?: string }> = []
          let idx = 0
          async function worker() {
            while (idx < input.urls.length) {
              const myIdx = idx++
              const url = input.urls[myIdx]!
              try {
                const { output } = await runRead(url, format, fetchOpts, stripImages)
                results[myIdx] = { url, ok: true, result: output }
              } catch (err: unknown) {
                results[myIdx] = { url, ok: false, error: err instanceof Error ? err.message : String(err) }
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, input.urls.length) }, worker))
          return { results }
        },
      }),
    )

    ctx.project.prompt.inject(
      'You have access to a Web Reader plugin. Call `web_read` to pull the main article content from a public URL (returns structured reader-mode output with title, byline, content as Markdown, images, metadata). Use `web_fetch_metadata` for a lighter preview, or `web_read_many` for batch research. These tools do NOT execute JavaScript — use them for static/SSR pages. For JS-rendered SPAs, use the browser plugin instead.',
    )
  },

  onProjectPluginActivated: async (projectId) => {
    console.log(`[jiku.web-reader] activated for project ${projectId}`)
  },

  onProjectPluginDeactivated: async (projectId) => {
    console.log(`[jiku.web-reader] deactivated for project ${projectId}`)
  },
})
