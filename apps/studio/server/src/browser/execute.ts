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
  projectId: string
  /** ID of the agent making the call. Drives per-agent tab affinity. */
  agentId: string
  timeoutMs?: number
  /**
   * If false, screenshots are returned inline as base64 data URLs in JSON
   * instead of being persisted to S3 + DB. Defaults to true.
   */
  screenshotAsAttachment?: boolean
}

/**
 * Actions that Studio's tab manager owns and the agent must NOT call
 * directly. Each agent gets exactly one tab; multi-tab orchestration would
 * conflict with our index tracking.
 */
const RESERVED_TAB_ACTIONS: ReadonlySet<BrowserAction> = new Set([
  'tab_new',
  'tab_close',
  'tab_switch',
  'tab_list',
  // `close` would close the entire chromium session and wipe every other
  // agent's tab. We expose `tab_close` for completeness in the schema docs
  // but block it here.
  'close',
])

export async function executeBrowserAction(
  input: BrowserToolInput,
  options: ExecuteBrowserOptions,
): Promise<{ content: ContentPart[] }> {
  const { cdpEndpoint, projectId, agentId, timeoutMs, screenshotAsAttachment = true } = options

  if (RESERVED_TAB_ACTIONS.has(input.action)) {
    throw new Error(
      `Browser action '${input.action}' is reserved by Studio. Each agent owns ` +
      `exactly one tab; use the other actions (open, snapshot, click, ...) to ` +
      `navigate and interact within it.`,
    )
  }

  // Everything below runs inside the per-project mutex so that two agents
  // can never interleave commands on the same chromium instance. Element
  // refs from a snapshot are guaranteed valid for the next command in the
  // same agent's sequence.
  return await browserMutex.acquire(projectId, async () => {
    // 1. Make sure this agent has a tab and that it's currently the active
    //    one in chromium. May open or evict tabs as a side effect.
    await ensureAgentTabActive(cdpEndpoint, projectId, agentId, timeoutMs)

    // 2. Run the requested command. The mutex guarantees no other agent
    //    can change the active tab between the switch above and this call.
    const command: BrowserCommand = mapToBrowserCommand(input)
    let result: BrowserResult<unknown>
    try {
      result = await execBrowserCommand(cdpEndpoint, command, { timeoutMs })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Browser action '${input.action}' failed: ${message}`)
    }

    // 3. Mark this agent's tab as recently used (for idle eviction).
    browserTabManager.touch(projectId, agentId)

    // 4. Format the result. Screenshots get persisted as attachments.
    if (input.action === 'screenshot' && result.success && result.data) {
      const screenshot = result.data as ScreenshotData
      const base64 = screenshot.base64
      const mimeType = `image/${screenshot.format ?? 'png'}`

      if (!screenshotAsAttachment) {
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
        projectId,
        agentId,
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

    // Everything else — return the parsed BrowserResult as JSON text so the
    // LLM sees both `success`, `data`, `error`, and `hint`.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    }
  })
}

/**
 * Ensure the calling agent has its own chromium tab and that the tab is the
 * currently-active one. Must be called from inside the project mutex —
 * we mutate state and run sequential CLI commands here.
 */
async function ensureAgentTabActive(
  cdpEndpoint: string,
  projectId: string,
  agentId: string,
  timeoutMs?: number,
): Promise<void> {
  browserTabManager.ensureInitialized(projectId)

  // Already have a tab? Just switch to it.
  const existingIdx = browserTabManager.getAgentTabIndex(projectId, agentId)
  if (existingIdx !== null) {
    await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'switch', index: existingIdx }, timeoutMs)
    return
  }

  // No tab yet. Evict the LRU tab if we're at capacity.
  if (browserTabManager.isAtCapacity(projectId)) {
    const victim = browserTabManager.pickEvictionCandidate(projectId)
    if (!victim) {
      throw new Error(
        `Browser project ${projectId} is at tab capacity but has no evictable agent tab.`,
      )
    }
    await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'close', index: victim.index }, timeoutMs)
    browserTabManager.removeTab(projectId, victim.index)
  }

  // Open a fresh tab and record it. We don't trust agent-browser's
  // auto-activate behavior — explicitly switch after creating.
  await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'new' }, timeoutMs)
  const newIdx = browserTabManager.appendTab(projectId, agentId)
  await runTabCommand(cdpEndpoint, { action: 'tab', operation: 'switch', index: newIdx }, timeoutMs)
}

/**
 * Run a tab management command and throw a clear error if the CLI reports
 * failure. Used for the implicit `tab_switch`/`tab_new`/`tab_close` calls
 * that the manager makes on behalf of agents.
 */
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

/** Throw a clear error when the LLM omitted a field that the action needs. */
function need<T>(value: T | undefined | null, action: BrowserAction, field: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Browser action '${action}' requires field '${field}'`)
  }
  return value
}

/**
 * Map the (flat) tool input to a `BrowserCommand` from `@jiku/browser`.
 *
 * The schema in `tool-schema.ts` is intentionally a flat `z.object` (with all
 * non-discriminator fields optional) so it serializes to a JSON Schema that
 * OpenAI's function-calling API accepts. Per-action requirements are
 * validated here at runtime via `need()`. The `never`-typed default branch
 * gives compile-time exhaustiveness over `BrowserAction`.
 *
 * Note: the `tab_*` and `close` actions are intercepted earlier in
 * `executeBrowserAction`. They appear in the schema for parity with
 * `@jiku/browser`'s `BrowserCommand`, but Studio reserves them.
 */
function mapToBrowserCommand(input: BrowserToolInput): BrowserCommand {
  const a = input.action
  switch (a) {
    // Navigation
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

    // Observation
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

    // Interaction
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

    // Wait
    case 'wait':
      return {
        action: 'wait',
        ...(input.ref !== undefined && { ref: input.ref }),
        ...(input.text !== undefined && { text: input.text }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.ms !== undefined && { ms: input.ms }),
      }

    // Tabs (flattened → nested operation). These are intercepted earlier;
    // the cases exist only for compile-time exhaustiveness.
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

    // JavaScript
    case 'eval':
      return { action: 'eval', js: need(input.js, a, 'js') }

    // Cookies & Storage (flattened → nested operation)
    case 'cookies_get':
      return { action: 'cookies', operation: 'get' }
    case 'cookies_clear':
      return { action: 'cookies', operation: 'clear' }
    case 'cookies_set':
      return { action: 'cookies', operation: 'set', cookie: need(input.cookie, a, 'cookie') }
    case 'storage':
      return { action: 'storage', storageType: need(input.storageType, a, 'storageType') }

    // Batch
    case 'batch':
      return { action: 'batch', commands: need(input.commands, a, 'commands') }

    default: {
      const _exhaustive: never = a
      throw new Error(`Unsupported browser action: ${String(_exhaustive)}`)
    }
  }
}
