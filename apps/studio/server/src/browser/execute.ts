import { execBrowserCommand } from '@jiku/browser'
import type { BrowserCommand, BrowserResult, ScreenshotData } from '@jiku/browser'
import type { ToolContentPart } from '@jiku/types'
import type { BrowserAction, BrowserToolInput } from './tool-schema.ts'
import { persistContentToAttachment } from '../content/persister.ts'

type ContentPart = ToolContentPart | { type: 'text'; text: string }

export interface ExecuteBrowserOptions {
  cdpEndpoint: string
  projectId: string
  timeoutMs?: number
  /**
   * If false, screenshots are returned inline as base64 data URLs in JSON
   * instead of being persisted to S3 + DB. Defaults to true.
   */
  screenshotAsAttachment?: boolean
}

export async function executeBrowserAction(
  input: BrowserToolInput,
  options: ExecuteBrowserOptions,
): Promise<{ content: ContentPart[] }> {
  const { cdpEndpoint, projectId, timeoutMs, screenshotAsAttachment = true } = options
  const command: BrowserCommand = mapToBrowserCommand(input)

  let result: BrowserResult<unknown>
  try {
    result = await execBrowserCommand(cdpEndpoint, command, { timeoutMs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Browser action '${input.action}' failed: ${message}`)
  }

  // Screenshot — optionally persist to S3 and return attachment reference.
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

    // Tabs (flattened → nested operation)
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
