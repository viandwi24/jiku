import { execBrowserCommand } from '@jiku/browser'
import type { BrowserCommand } from '@jiku/browser'
import type { ToolContentPart } from '@jiku/types'
import type { BrowserToolInput } from './tool-schema.js'
import { resolveCdpEndpoint } from './config.ts'

type ContentPart = ToolContentPart | { type: 'text'; text: string }

export async function executeBrowserAction(
  args: BrowserToolInput,
  cdpEndpoint: string,
  projectId?: string,
): Promise<{ content: ContentPart[] }> {
  const { action } = args

  // Map tool input to BrowserCommand from @jiku/browser
  const command: BrowserCommand = mapToBrowserCommand(args)

  try {
    // Execute via @jiku/browser's CLI bridge
    const result = await execBrowserCommand(cdpEndpoint, command)

    // Handle screenshot specially — persist to S3 and return attachment reference
    if (action === 'screenshot' && result.type === 'screenshot') {
      if (!projectId) {
        throw new Error('projectId required for screenshot persistence')
      }

      // result.data is base64 from the browser CLI
      const base64Data = result.data
      const buffer = Buffer.from(base64Data, 'base64')
      const mimeType = args.type === 'jpeg' ? 'image/jpeg' : 'image/png'

      const { persistContentToAttachment } = await import('../content/persister.ts')
      const attachment = await persistContentToAttachment({
        projectId,
        data: buffer,
        mimeType,
        filename: `screenshot-${Date.now()}.${args.type === 'jpeg' ? 'jpg' : 'png'}`,
        sourceType: 'browser',
        metadata: {
          action: 'screenshot',
        },
      })

      return {
        content: [{
          type: 'image',
          attachment_id: attachment.attachmentId,
          storage_key: attachment.storageKey,
          mime_type: attachment.mimeType,
        }],
      }
    }

    // For all other actions, return result as JSON
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Browser action '${action}' failed: ${message}`)
  }
}

/**
 * Map tool input (from LLM) to BrowserCommand (@jiku/browser format).
 * This is a simplified mapping — not all OpenClaw actions are supported yet.
 */
function mapToBrowserCommand(args: BrowserToolInput): BrowserCommand {
  const { action } = args

  switch (action) {
    case 'open':
      return { action: 'open', url: args.targetUrl ?? 'about:blank' }

    case 'screenshot':
      return {
        action: 'screenshot',
        type: args.type ?? 'png',
        fullPage: args.fullPage ?? false,
      }

    case 'snapshot':
      return { action: 'snapshot' }

    case 'navigate':
      return { action: 'open', url: args.targetUrl ?? 'about:blank' }

    case 'click':
      return {
        action: 'click',
        ref: args.ref ?? '',
        doubleClick: args.doubleClick ?? false,
        button: args.button ?? 'left',
      }

    case 'fill':
      return { action: 'fill', ref: args.ref ?? '', text: args.text ?? '' }

    case 'type':
      return { action: 'type', ref: args.ref ?? '', text: args.text ?? '' }

    case 'press':
      return { action: 'press', key: args.key ?? '' }

    case 'hover':
      return { action: 'hover', ref: args.ref ?? '' }

    case 'focus':
      return { action: 'focus', ref: args.ref ?? '' }

    case 'select':
      return { action: 'select', ref: args.ref ?? '', values: args.values ?? [] }

    case 'wait':
      return {
        action: 'wait',
        timeMs: args.timeMs,
        text: args.text,
        textGone: args.textGone,
        selector: args.selector,
      }

    case 'evaluate':
      return { action: 'evaluate', fn: args.fn ?? '' }

    case 'get':
      return { action: 'get', path: args.path ?? '' }

    case 'close':
      return { action: 'close' }

    default:
      throw new Error(`Unsupported browser action: ${action}`)
  }
}
