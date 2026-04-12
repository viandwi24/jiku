// In-memory registry of file view adapters contributed by plugins.
// Plugins call ctx.fileViewAdapters.register() during setup, which stores the
// spec here. The /active endpoint reads this to include adapter specs in the response.

export interface FileViewAdapterSpec {
  id: string
  label: string
  extensions: string[]
}

const registry = new Map<string, FileViewAdapterSpec[]>()

export function registerFileViewAdapter(pluginId: string, spec: FileViewAdapterSpec): void {
  const list = registry.get(pluginId) ?? []
  const existing = list.findIndex(s => s.id === spec.id)
  if (existing >= 0) {
    list[existing] = spec
  } else {
    list.push(spec)
  }
  registry.set(pluginId, list)
}

export function getFileViewAdaptersForPlugin(pluginId: string): FileViewAdapterSpec[] {
  return registry.get(pluginId) ?? []
}

export function clearFileViewAdapters(pluginId: string): void {
  registry.delete(pluginId)
}

/**
 * Build a map of lowercase extension → tool hint for all registered adapters.
 * Used by fs_read to tell agents which specialised tool to use for binary files.
 *
 * For example, if the jiku.sheet plugin registers extensions ['.xlsx', '.csv']
 * with id 'jiku.sheet.spreadsheet', the result includes:
 *   'xlsx' → 'sheet_read'
 *   'csv'  → 'sheet_read'
 *
 * The tool name is derived by convention: take the last segment of the adapter id
 * (e.g. 'jiku.sheet.spreadsheet' → 'spreadsheet'), look it up against a known
 * mapping, falling back to the adapter label if no mapping exists.
 */
const ADAPTER_ID_TO_TOOL: Record<string, string> = {
  'jiku.sheet.spreadsheet': 'sheet_read',
  'spreadsheet': 'sheet_read',
}

export function buildBinaryFileHints(): Map<string, string> {
  const hints = new Map<string, string>()
  for (const specs of registry.values()) {
    for (const spec of specs) {
      const tool = ADAPTER_ID_TO_TOOL[spec.id] ?? ADAPTER_ID_TO_TOOL[spec.id.split('.').pop() ?? '']
      if (!tool) continue
      for (const ext of spec.extensions) {
        const bare = ext.replace(/^\./, '').toLowerCase()
        hints.set(bare, tool)
      }
    }
  }
  return hints
}
