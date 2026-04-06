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
          'Use action=status to check browser state. Use action=start to launch the browser.',
          'Use action=snapshot to read the current page content as accessibility tree.',
          'Use action=navigate to go to a URL. Use action=act to click, type, press keys, hover, drag, fill forms.',
          'Use action=screenshot to capture a visual snapshot. Use action=tabs to list open tabs.',
          'Use action=open to open a new tab. Use action=console to read browser console messages.',
        ].join(' '),
        group: 'browser',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: BrowserToolInputSchema,
      execute: async (args) => {
        return executeBrowserAction(args as import('./tool-schema.js').BrowserToolInput, serverBaseUrl, projectId)
      },
    },
  ]
}
