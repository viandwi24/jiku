import { z } from 'zod'
import { BrowserAdapter } from '@jiku/kit'
import type {
  BrowserAdapterContext,
  BrowserAdapterResult,
  BrowserPingResult,
  BrowserPreviewResult,
} from '@jiku/kit'
import { execBrowserCommand } from '@jiku/browser'
import type { ScreenshotData, BrowserResult } from '@jiku/browser'
import { browserMutex } from '../concurrency.ts'
import { browserTabManager } from '../tab-manager.ts'
import {
  mapToBrowserCommand,
  formatBrowserResult,
  ensureAgentTabActive,
  isReservedBrowserAction,
} from '../execute.ts'
import { resolveCdpEndpoint } from '../config.ts'
import type { BrowserToolInput } from '../tool-schema.ts'
import type { JikuBrowserVercelConfig } from './jiku-browser-vercel-types.ts'
import { MIN_MAX_TABS, MAX_MAX_TABS } from '../tab-manager.ts'

export const JikuBrowserVercelConfigSchema = z.object({
  cdp_url: z.string()
    .describe('CDP WebSocket URL of the Chromium instance (e.g. ws://localhost:9222).')
    .default('ws://localhost:9222'),
  timeout_ms: z.number().int()
    .min(1000).max(120_000)
    .describe('Per-command timeout in milliseconds. Range: 1000 – 120000.')
    .default(30_000),
  evaluate_enabled: z.boolean()
    .describe('Allow agents to run arbitrary JavaScript in the page via the eval action. Disabled by default for safety.')
    .default(false),
  screenshot_as_attachment: z.boolean()
    .describe('Persist screenshots to S3 as attachments (recommended). When off, screenshots are returned inline as base64.')
    .default(true),
  max_tabs: z.number().int()
    .min(MIN_MAX_TABS).max(MAX_MAX_TABS)
    .describe(`Maximum Chromium tabs for this profile (includes the system tab). Range: ${MIN_MAX_TABS} – ${MAX_MAX_TABS}.`)
    .default(10),
})

export type { JikuBrowserVercelConfig }

export class JikuBrowserVercelAdapter extends BrowserAdapter {
  readonly id = 'jiku.browser.vercel'
  readonly displayName = 'Jiku Browser Agent'
  readonly description = [
    'Connects to a Chromium-based browser via Chrome DevTools Protocol (CDP).',
    'Powered by Vercel agent-browser. Recommended setup: run the bundled Jiku',
    'Browser Docker container (Chromium + noVNC) and point cdp_url at port 9222.',
  ].join(' ')
  readonly configSchema = JikuBrowserVercelConfigSchema

  async execute(input: unknown, ctx: BrowserAdapterContext): Promise<BrowserAdapterResult> {
    const args = input as BrowserToolInput
    const config = (ctx.config ?? {}) as JikuBrowserVercelConfig
    const cdpEndpoint = resolveCdpEndpoint(config)
    const timeoutMs = config.timeout_ms
    const screenshotAsAttachment = config.screenshot_as_attachment ?? true

    if (isReservedBrowserAction(args.action)) {
      throw new Error(
        `Browser action '${args.action}' is reserved by Studio — use open/snapshot/click/... instead.`,
      )
    }
    if (args.action === 'eval' && !(config.evaluate_enabled ?? false)) {
      throw new Error('Browser eval is disabled for this profile. Enable it in the profile config.')
    }

    return browserMutex.acquire(ctx.profileId, async () => {
      const agentId = ctx.agentId
      if (agentId) {
        await ensureAgentTabActive(cdpEndpoint, ctx.profileId, agentId, config.max_tabs, timeoutMs)
      }

      const command = mapToBrowserCommand(args)
      let result: BrowserResult<unknown>
      try {
        result = await execBrowserCommand(cdpEndpoint, command, { timeoutMs })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Browser action '${args.action}' failed: ${message}`)
      }
      if (agentId) browserTabManager.touch(ctx.profileId, agentId)

      const formatted = await formatBrowserResult(result, args, {
        projectId: ctx.projectId,
        agentId: agentId ?? 'system',
        screenshotAsAttachment,
      })
      return { content: formatted.content } as BrowserAdapterResult
    })
  }

  async ping(config: unknown): Promise<BrowserPingResult> {
    const cfg = (config ?? {}) as JikuBrowserVercelConfig
    const cdpUrl = resolveCdpEndpoint(cfg)
    const httpUrl = cdpUrl.replace(/^ws/, 'http')
    const start = Date.now()
    try {
      const controller = new AbortController()
      const to = setTimeout(() => controller.abort(), 5000)
      try {
        const r = await fetch(`${httpUrl}/json/version`, { signal: controller.signal })
        const latency = Date.now() - start
        if (!r.ok) {
          return { ok: false, error: `CDP endpoint returned HTTP ${r.status}`, latency_ms: latency, cdp_url: cdpUrl }
        }
        const info = (await r.json()) as Record<string, string>
        return {
          ok: true,
          latency_ms: latency,
          browser: info['Browser'] ?? info['product'] ?? 'unknown',
          cdp_url: cdpUrl,
        }
      } finally {
        clearTimeout(to)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Cannot reach CDP at ${cdpUrl} — ${msg}`, cdp_url: cdpUrl }
    }
  }

  async preview(config: unknown): Promise<BrowserPreviewResult> {
    const cfg = (config ?? {}) as JikuBrowserVercelConfig
    const cdpEndpoint = resolveCdpEndpoint(cfg)
    const timeoutMs = cfg.timeout_ms ?? 30_000

    try {
      const screenshot = await execBrowserCommand<ScreenshotData>(
        cdpEndpoint,
        { action: 'screenshot' },
        { timeoutMs },
      )
      if (!screenshot.success || !screenshot.data) {
        return { ok: false, error: screenshot.error ?? 'Screenshot failed', hint: screenshot.hint ?? null }
      }
      const [titleResult, urlResult] = await Promise.all([
        execBrowserCommand<{ title: string }>(cdpEndpoint, { action: 'get', subcommand: 'title' }, { timeoutMs }).catch(() => null),
        execBrowserCommand<{ url: string }>(cdpEndpoint, { action: 'get', subcommand: 'url' }, { timeoutMs }).catch(() => null),
      ])
      return {
        ok: true,
        data: {
          base64: screenshot.data.base64,
          format: (screenshot.data.format ?? 'png') as 'png' | 'jpeg',
          title: titleResult?.success ? titleResult.data?.title ?? null : null,
          url: urlResult?.success ? urlResult.data?.url ?? null : null,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  }

  override async onProfileDeactivated(profileId: string): Promise<void> {
    browserTabManager.dropProfile(profileId)
  }
}

export const jikuBrowserVercelAdapter = new JikuBrowserVercelAdapter()
