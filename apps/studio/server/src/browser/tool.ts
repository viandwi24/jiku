import type { ToolDefinition } from '@jiku/types'
import type { BrowserProjectConfig } from '@jiku-studio/db'
import { BrowserToolInputSchema, type BrowserToolInput } from './tool-schema.ts'
import { executeBrowserAction } from './execute.ts'
import { resolveCdpEndpoint } from './config.ts'

export function buildBrowserTools(
  projectId: string,
  config: BrowserProjectConfig | undefined | null,
): ToolDefinition[] {
  const cdpEndpoint = resolveCdpEndpoint(config)
  const timeoutMs = config?.timeout_ms
  const screenshotAsAttachment = config?.screenshot_as_attachment ?? true
  const evalEnabled = config?.evaluate_enabled ?? false

  return [
    {
      meta: {
        id: 'browser',
        name: 'Browser',
        description: [
          'Control a real browser via @jiku/browser (CDP bridge to agent-browser).',
          '',
          'WORKFLOW:',
          '1. action=open — navigate to a URL.',
          '2. action=snapshot (interactive=true) — read the page as an accessibility tree with element refs (@e1, @e2, ...).',
          '3. action=click/type/fill/press — interact using refs from the snapshot.',
          '   After any action that changes the DOM, snapshot again to refresh refs.',
          '4. action=screenshot — capture visual state.',
          '5. action=close — close the browser when done.',
          '',
          'NAVIGATION: open, back, forward, reload, close.',
          'OBSERVATION: snapshot, screenshot, pdf, get.',
          'INTERACTION: click, dblclick, fill, type, press, hover, focus, check, uncheck, select, drag, upload, scroll, scrollintoview.',
          'WAIT: wait (ref/text/url/ms).',
          'TABS: tab_list, tab_new, tab_close, tab_switch.',
          'STORAGE: cookies_get, cookies_set, cookies_clear, storage.',
          'BATCH: batch (run multiple commands sequentially).',
          evalEnabled
            ? 'JS: eval — run arbitrary JavaScript in the page.'
            : 'JS: eval is disabled in this project. Ask an admin to enable it.',
          '',
          `CDP endpoint: ${cdpEndpoint}`,
          'Single active tab — concurrent users on the same project will conflict.',
          'Each command spawns a fresh CLI process; no state is preserved between calls.',
        ].join(' '),
        group: 'browser',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: BrowserToolInputSchema,
      execute: async (args) => {
        const input = args as BrowserToolInput
        if (input.action === 'eval' && !evalEnabled) {
          throw new Error('Browser eval is disabled for this project. Enable it in Browser settings.')
        }
        return executeBrowserAction(input, {
          cdpEndpoint,
          projectId,
          timeoutMs,
          screenshotAsAttachment,
        })
      },
    },
  ]
}
