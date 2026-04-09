import type { ToolDefinition } from '@jiku/types'
import { BrowserToolInputSchema } from './tool-schema.js'
import { executeBrowserAction } from './execute.js'
import { resolveCdpEndpoint } from './config.ts'
import type { BrowserProjectConfig } from '@jiku-studio/db'

export function buildBrowserTools(projectId: string, config: BrowserProjectConfig | undefined | null): ToolDefinition[] {
  const cdpEndpoint = resolveCdpEndpoint(config)

  return [
    {
      meta: {
        id: 'browser',
        name: 'Browser',
        description: [
          'Control the browser: navigate pages, interact with UI elements, take screenshots, and extract data.',
          '',
          'WORKFLOW — always follow this order:',
          '1. action=open — navigate to a URL (launch browser if needed).',
          '2. action=snapshot — read the current page as an accessibility tree. ALWAYS snapshot before interacting.',
          '3. action=click/type/fill — interact using selectors from the snapshot.',
          '   - After each interaction that changes the page: snapshot again.',
          '4. action=screenshot — capture visual state when you need to see how the page looks.',
          '5. action=close — close the browser when done.',
          '',
          'Other actions: action=get (read page content), action=evaluate (run JS), action=wait (wait for condition).',
          '',
          'IMPORTANT NOTES:',
          '- CDP endpoint: ' + cdpEndpoint,
          '- Each action is stateless — page state (logs, network) is not retained between calls.',
          '- Single active tab only — concurrent users will interfere with each other.',
        ].join(' '),
        group: 'browser',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: BrowserToolInputSchema,
      execute: async (args) => {
        // Strip profile from AI input — profile is always the owning projectId, never AI-controlled
        const { profile: _ignored, ...safeArgs } = args as import('./tool-schema.js').BrowserToolInput & { profile?: string }
        return executeBrowserAction(safeArgs as import('./tool-schema.js').BrowserToolInput, cdpEndpoint, projectId)
      },
    },
  ]
}
