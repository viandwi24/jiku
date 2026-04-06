import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from './browser/client-actions.js'
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from './browser/client.js'
import { wrapExternalContent } from './security/external-content.js'
import type { BrowserToolInput } from './tool-schema.js'

type ContentPart = { type: string; text?: string; data?: string; mimeType?: string }

export async function executeBrowserAction(
  args: BrowserToolInput,
  baseUrl: string,
  projectId?: string,
): Promise<{ content: ContentPart[] }> {
  const { action } = args
  // Always use the projectId as the profile so each project is isolated.
  // Ignore whatever the AI passes in — it doesn't know the profile name.
  const profile = projectId ?? undefined

  switch (action) {
    case 'status':
      return { content: [{ type: 'text', text: JSON.stringify(await browserStatus(baseUrl, { profile })) }] }

    case 'start':
      await browserStart(baseUrl, { profile })
      return { content: [{ type: 'text', text: JSON.stringify(await browserStatus(baseUrl, { profile })) }] }

    case 'stop':
      await browserStop(baseUrl, { profile })
      return { content: [{ type: 'text', text: JSON.stringify(await browserStatus(baseUrl, { profile })) }] }

    case 'profiles':
      return { content: [{ type: 'text', text: JSON.stringify({ profiles: await browserProfiles(baseUrl) }) }] }

    case 'tabs': {
      const tabs = await browserTabs(baseUrl, { profile })
      return { content: [{ type: 'text', text: JSON.stringify({ tabs }) }] }
    }

    case 'open': {
      const tab = await browserOpenTab(baseUrl, args.targetUrl ?? 'about:blank', { profile })
      return { content: [{ type: 'text', text: JSON.stringify(tab) }] }
    }

    case 'focus':
      await browserFocusTab(baseUrl, args.targetId!, { profile })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }

    case 'close':
      if (args.targetId) {
        await browserCloseTab(baseUrl, args.targetId, { profile })
      } else {
        await browserAct(baseUrl, { kind: 'close' }, { profile })
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }

    case 'navigate':
      return { content: [{ type: 'text', text: JSON.stringify(await browserNavigate(baseUrl, { url: args.targetUrl!, targetId: args.targetId, profile })) }] }

    case 'snapshot': {
      const snapshot = await browserSnapshot(baseUrl, { ...args, profile })
      const text = wrapExternalContent(JSON.stringify(snapshot), { source: 'browser', includeWarning: true })
      return { content: [{ type: 'text', text }] }
    }

    case 'screenshot': {
      const result = await browserScreenshotAction(baseUrl, { ...args, profile })
      const { readFile } = await import('node:fs/promises')
      const data = await readFile(result.path)
      return {
        content: [
          { type: 'text', text: `Screenshot saved: ${result.path}` },
          { type: 'image', data: data.toString('base64'), mimeType: args.type === 'jpeg' ? 'image/jpeg' : 'image/png' },
        ],
      }
    }

    case 'console': {
      const result = await browserConsoleMessages(baseUrl, { level: args.level, targetId: args.targetId, profile })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }

    case 'pdf': {
      const result = await browserPdfSave(baseUrl, { targetId: args.targetId, profile })
      return { content: [{ type: 'text', text: `PDF saved: ${result.path}` }] }
    }

    case 'upload':
      return { content: [{ type: 'text', text: JSON.stringify(await browserArmFileChooser(baseUrl, { paths: args.paths!, ref: args.ref, inputRef: args.inputRef, element: args.element, targetId: args.targetId, timeoutMs: args.timeoutMs, profile })) }] }

    case 'dialog':
      return { content: [{ type: 'text', text: JSON.stringify(await browserArmDialog(baseUrl, { accept: args.accept!, promptText: args.promptText, targetId: args.targetId, timeoutMs: args.timeoutMs, profile })) }] }

    case 'act':
      return { content: [{ type: 'text', text: JSON.stringify(await browserAct(baseUrl, args.request!, { profile })) }] }

    default:
      throw new Error(`Unknown browser action: ${action}`)
  }
}
