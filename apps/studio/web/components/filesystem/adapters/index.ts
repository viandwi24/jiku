// Registers built-in file view adapters into the static registry.
// Plugin-contributed adapters (e.g. jiku.sheet) are loaded dynamically via
// the plugin UI registry (file.view.adapter slot) — not registered here.

import { registerAdapter } from '@/lib/file-view-adapters'
import { MarkdownViewAdapter } from './markdown-adapter'

// ── Built-in adapters ───────────────────────────────────────────
registerAdapter({
  id: 'markdown',
  label: 'Preview',
  extensions: ['.md', '.mdx', '.markdown'],
  component: MarkdownViewAdapter,
})
