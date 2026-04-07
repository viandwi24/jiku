import type { ToolDefinition } from '@jiku/types'
import { BrowserToolInputSchema } from './tool-schema.js'
import { executeBrowserAction } from './execute.js'

export function buildBrowserTools(serverBaseUrl: string, projectId: string): ToolDefinition[] {
  return [
    {
      meta: {
        id: 'browser',
        name: 'Browser',
        description: [
          'Control the browser: navigate pages, interact with UI elements, take screenshots, and extract data.',
          '',
          'WORKFLOW — always follow this order:',
          '1. action=start — launch the browser (required before anything else).',
          '2. action=navigate — go to a URL.',
          '3. action=snapshot — read the current page as an accessibility tree. ALWAYS snapshot before interacting.',
          '4. action=act — interact using a ref from the snapshot (click, type, press, hover, drag, fill, select).',
          '   - Every act REQUIRES a ref (e.g. ref="e12") obtained from the snapshot.',
          '   - After each click that opens a menu, modal, or changes the page: snapshot again before the next act.',
          '   - For typing into an input: click the input ref first, then type.',
          '   - NEVER guess a ref — always snapshot first to get current refs.',
          '5. action=screenshot — capture a visual snapshot when you need to see the visual state.',
          '',
          'Other actions: action=tabs (list tabs), action=open (new tab), action=console (read console logs).',
          '',
          'COMMON MISTAKES TO AVOID:',
          '- Do NOT call action=act without a ref from a recent snapshot.',
          '- Do NOT assume refs stay the same after navigation or interaction — snapshot again.',
          '- Do NOT call action=type without first clicking the input element.',
          '- Do NOT retry after an error without snapshotting first to understand current page state.',
        ].join(' '),
        group: 'browser',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: BrowserToolInputSchema,
      execute: async (args) => {
        // Strip profile from AI input — profile is always the owning projectId, never AI-controlled
        const { profile: _ignored, ...safeArgs } = args as import('./tool-schema.js').BrowserToolInput & { profile?: string }
        return executeBrowserAction(safeArgs as import('./tool-schema.js').BrowserToolInput, serverBaseUrl, projectId)
      },
    },
  ]
}
