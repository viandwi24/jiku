// Plugin UI types — kept in @jiku/types so they can be referenced by
// PluginDefinition without @jiku/types depending on React or @jiku/kit.

export type PluginUISlotId =
  | 'sidebar.item'
  | 'project.page'
  | 'agent.page'
  | 'agent.settings.tab'
  | 'project.settings.section'
  | 'dashboard.widget'
  | 'chat.compose.action'
  | 'chat.message.action'
  | 'conversation.panel.right'
  | 'command.palette.item'
  | 'global.modal'
  /** File view adapter: renders a file in a custom view.
   *  meta: { label: string, extensions: string[] }
   *  mount receives extra keys: projectId, path, filename, content */
  | 'file.view.adapter'

export interface PluginUIEntry {
  slot: PluginUISlotId
  /** Stable id scoped to this plugin, e.g. 'dashboard'. */
  id: string
  /** Path (relative to the plugin's asset root) of the compiled ESM module, e.g. './Dashboard.js'. */
  module: string
  meta: Record<string, unknown>
  requires?: string
}

export interface PluginUIDefinition {
  apiVersion?: '1'
  /** Absolute filesystem path to the plugin's built UI assets (`dist/ui/` typically).
   *  Server uses this to serve assets under `/api/plugins/:id/ui/*`.
   *  Plugin sets this via `new URL('../dist/ui', import.meta.url).pathname`. */
  assetsDir?: string
  entries: PluginUIEntry[]
}
