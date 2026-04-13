import { execBrowserCommand } from '@jiku/browser'
import type { BrowserCommand, BrowserResult, ScreenshotData } from '@jiku/browser'
import type { ToolContentPart } from '@jiku/types'
import type { BrowserAction, BrowserToolInput } from './tool-schema.ts'
import { persistContentToAttachment } from '../content/persister.ts'
import { browserMutex } from './concurrency.ts'
import { browserTabManager } from './tab-manager.ts'

type ContentPart = ToolContentPart | { type: 'text'; text: string }

export interface ExecuteBrowserOptions {
  cdpEndpoint: string
  /** Profile that owns this browser instance (Plan 20 — formerly projectId). */
  profileId: string
  /** Project the call is made against (used for attachment association). */
  projectId: string
  /** Agent making the call. Drives per-agent tab affinity. */
  agentId: string
  timeoutMs?: number
  screenshotAsAttachment?: boolean
  maxTabs?: number
}

/** Actions reserved by Studio; agents must NOT call them directly. */
const RESERVED_TAB_ACTIONS: ReadonlySet<BrowserAction> = new Set([
  'tab_new',
  'tab_close',
  'tab_switch',
  'tab_list',
  'close',
])

/**
 * Legacy one-shot entry point. Builds a BrowserCommand, runs it, applies
 * the screenshot-persistence logic, and formats the result. Retained for
 * the backward-compat `routes/browser.ts` shim.
 */
export async function executeBrowserAction(
  input: BrowserToolInput,
  options: ExecuteBrowserOptions,
): Promise<{ content: ContentPart[] }> {
  const { cdpEndpoint, profileId, projectId, agentId, timeoutMs, screenshotAsAttachment = true, maxTabs } = options

  if (RESERVED_TAB_ACTIONS.has(input.action)) {
    throw new Error(
      `Browser action '${input.action}' is reserved by Studio. Each agent owns ` +
      `exactly one tab; use the other actions (open, snapshot, click, ...) to ` +
      `navigate and interact within it.`,
    )
  }

  return await browserMutex.acquire(profileId, async () => {
    await ensureAgentTabActive(cdpEndpoint, profileId, agentId, maxTabs, timeoutMs)

    const command: BrowserCommand = mapToBrowserCommand(input)
    let result: BrowserResult<unknown>
    try {
      result = await execBrowserCommand(cdpEndpoint, command, { timeoutMs })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Browser action '${input.action}' failed: ${message}`)
    }

    browserTabManager.touch(profileId, agentId)

    return formatBrowserResult(result, input, { projectId, agentId, screenshotAsAttachment })
  })
}

/**
 * Ensure the calling agent has its own chromium tab and that the tab is the
 * currently-active one. Must be called from inside the profile mutex.
 */
export async function ensureAgentTabActive(
  cdpEndpoint: string,
  profileId: string,
  agentId: string,
  maxTabs: number | undefined,
  timeoutMs?: number,
): Promise<void> {
  browserTabManager.ensureInitialized(profileId, maxTabs)

  const existingIdx = browserTabManager.getAgentTabIndex(profileId, agentId)
  if (existingIdx !== null) {
    await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'switch', index: existingIdx }, timeoutMs)
    return
  }

  if (browserTabManager.isAtCapacity(profileId)) {
    const victim = browserTabManager.pickEvictionCandidate(profileId)
    if (!victim) {
      throw new Error(
        `Browser profile ${profileId} is at tab capacity but has no evictable agent tab.`,
      )
    }
    await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'close', index: victim.index }, timeoutMs)
    browserTabManager.removeTab(profileId, victim.index)
  }

  await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'new' }, timeoutMs)
  const newIdx = browserTabManager.appendTab(profileId, agentId)
  await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'switch', index: newIdx }, timeoutMs)
}

async function runTabCommand(
  cdpEndpoint: string,
  command: BrowserCommand,
  timeoutMs?: number,
): Promise<void> {
  const result = await execBrowserCommand(cdpEndpoint, command, { timeoutMs })
  if (!result.success) {
    throw new Error(
      `Studio tab manager: '${command.action}' failed — ${result.error ?? 'unknown error'}`,
    )
  }
}

/**
 * Format a raw BrowserResult into the tool response shape. Extracted so
 * the BrowserAdapter implementations can reuse it for their `execute()`.
 */
export async function formatBrowserResult(
  result: BrowserResult<unknown>,
  input: BrowserToolInput,
  ctx: { projectId: string; agentId: string; screenshotAsAttachment: boolean },
): Promise<{ content: ContentPart[] }> {
  if (input.action === 'screenshot' && result.success && result.data) {
    const screenshot = result.data as ScreenshotData
    const base64 = screenshot.base64
    const mimeType = `image/${screenshot.format ?? 'png'}`

    if (!ctx.screenshotAsAttachment) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              data: { base64, format: screenshot.format ?? 'png', mimeType },
            }),
          },
        ],
      }
    }

    const buffer = Buffer.from(base64, 'base64')
    const ext = screenshot.format ?? 'png'
    const attachment = await persistContentToAttachment({
      projectId: ctx.projectId,
      agentId: ctx.agentId,
      data: buffer,
      mimeType,
      filename: `screenshot-${Date.now()}.${ext}`,
      sourceType: 'browser',
      metadata: { action: 'screenshot' },
    })

    return {
      content: [
        {
          type: 'image',
          attachment_id: attachment.attachmentId,
          storage_key: attachment.storageKey,
          mime_type: attachment.mimeType,
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result),
      },
    ],
  }
}

function need<T>(value: T | undefined | null, action: BrowserAction, field: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Browser action '${action}' requires field '${field}'`)
  }
  return value
}

/**
 * Map the flat tool input to a `BrowserCommand`. Exported so the built-in
 * JikuBrowserVercelAdapter can reuse it.
 */
export function mapToBrowserCommand(input: BrowserToolInput): BrowserCommand {
  const a = input.action
  switch (a) {
    case 'open':
      return { action: 'open', url: need(input.url, a, 'url') }
    case 'back':
      return { action: 'back' }
    case 'forward':
      return { action: 'forward' }
    case 'reload':
      return { action: 'reload' }
    case 'close':
      return { action: 'close' }

    case 'snapshot':
      return {
        action: 'snapshot',
        ...(input.interactive !== undefined && { interactive: input.interactive }),
        ...(input.compact !== undefined && { compact: input.compact }),
        ...(input.depth !== undefined && { depth: input.depth }),
        ...(input.selector !== undefined && { selector: input.selector }),
      }
    case 'screenshot':
      return {
        action: 'screenshot',
        ...(input.full !== undefined && { full: input.full }),
        ...(input.annotate !== undefined && { annotate: input.annotate }),
      }
    case 'pdf':
      return { action: 'pdf', path: need(input.path, a, 'path') }
    case 'get':
      return {
        action: 'get',
        subcommand: need(input.subcommand, a, 'subcommand'),
        ...(input.ref !== undefined && { ref: input.ref }),
        ...(input.attr !== undefined && { attr: input.attr }),
      }

    case 'click':
      return {
        action: 'click',
        ref: need(input.ref, a, 'ref'),
        ...(input.newTab !== undefined && { newTab: input.newTab }),
      }
    case 'dblclick':
      return { action: 'dblclick', ref: need(input.ref, a, 'ref') }
    case 'fill':
      return { action: 'fill', ref: need(input.ref, a, 'ref'), text: need(input.text, a, 'text') }
    case 'type':
      return { action: 'type', ref: need(input.ref, a, 'ref'), text: need(input.text, a, 'text') }
    case 'press':
      return { action: 'press', key: need(input.key, a, 'key') }
    case 'hover':
      return { action: 'hover', ref: need(input.ref, a, 'ref') }
    case 'focus':
      return { action: 'focus', ref: need(input.ref, a, 'ref') }
    case 'check':
      return { action: 'check', ref: need(input.ref, a, 'ref') }
    case 'uncheck':
      return { action: 'uncheck', ref: need(input.ref, a, 'ref') }
    case 'select':
      return {
        action: 'select',
        ref: need(input.ref, a, 'ref'),
        values: need(input.values, a, 'values'),
      }
    case 'drag':
      return { action: 'drag', src: need(input.src, a, 'src'), dst: need(input.dst, a, 'dst') }
    case 'upload':
      return {
        action: 'upload',
        ref: need(input.ref, a, 'ref'),
        files: need(input.files, a, 'files'),
      }
    case 'scroll':
      return {
        action: 'scroll',
        direction: need(input.direction, a, 'direction'),
        ...(input.pixels !== undefined && { pixels: input.pixels }),
      }
    case 'scrollintoview':
      return { action: 'scrollintoview', ref: need(input.ref, a, 'ref') }

    case 'wait':
      return {
        action: 'wait',
        ...(input.ref !== undefined && { ref: input.ref }),
        ...(input.text !== undefined && { text: input.text }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.ms !== undefined && { ms: input.ms }),
      }

    case 'tab_list':
      return { action: 'tab', operation: 'list' }
    case 'tab_new':
      return input.url !== undefined
        ? { action: 'tab', operation: 'new', url: input.url }
        : { action: 'tab', operation: 'new' }
    case 'tab_close':
      return input.index !== undefined
        ? { action: 'tab', operation: 'close', index: input.index }
        : { action: 'tab', operation: 'close' }
    case 'tab_switch':
      return { action: 'tab', operation: 'switch', index: need(input.index, a, 'index') }

    case 'eval':
      return { action: 'eval', js: need(input.js, a, 'js') }

    case 'cookies_get':
      return { action: 'cookies', operation: 'get' }
    case 'cookies_clear':
      return { action: 'cookies', operation: 'clear' }
    case 'cookies_set':
      return { action: 'cookies', operation: 'set', cookie: need(input.cookie, a, 'cookie') }
    case 'storage':
      return { action: 'storage', storageType: need(input.storageType, a, 'storageType') }

    case 'batch':
      return { action: 'batch', commands: need(input.commands, a, 'commands') }

    default: {
      const _exhaustive: never = a
      throw new Error(`Unsupported browser action: ${String(_exhaustive)}`)
    }
  }
}

/** Reserved-action guard exposed for adapters. */
export function isReservedBrowserAction(action: BrowserAction): boolean {
  return RESERVED_TAB_ACTIONS.has(action)
}
