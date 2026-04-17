import { definePlugin } from '@jiku/kit'
import StudioPlugin from '@jiku-plugin/studio'
import { camofoxAdapter } from './adapter.ts'

export default definePlugin({
  meta: {
    id: 'jiku.camofox',
    name: 'CamoFox Browser',
    version: '1.0.0',
    description: 'Adds CamoFox as a browser adapter — Firefox-based browser with anti-fingerprinting. Register profiles that point at an externally-launched CamoFox CDP endpoint.',
    author: 'Jiku',
    icon: '🦊',
    category: 'browser',
  },
  depends: [StudioPlugin],
  setup(ctx) {
    ctx.browser.register(camofoxAdapter)
  },
})
