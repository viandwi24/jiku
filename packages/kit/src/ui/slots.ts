// Slot contract for Plugin UI (Plan 17).

export type SlotId =
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

export interface SlotMetaMap {
  'sidebar.item': { label: string; icon?: string; order?: number; href?: string }
  'project.page': { path: string; title: string; icon?: string }
  'agent.page': { path: string; title: string; icon?: string }
  'agent.settings.tab': { label: string; icon?: string; order?: number }
  'project.settings.section': { label: string; icon?: string; order?: number }
  'dashboard.widget': { title: string; defaultSize?: 'sm' | 'md' | 'lg'; order?: number }
  'chat.compose.action': { label: string; icon?: string; order?: number }
  'chat.message.action': { label: string; icon?: string; order?: number }
  'conversation.panel.right': { label: string; icon?: string; order?: number }
  'command.palette.item': { label: string; keywords?: string[] }
  'global.modal': { id: string }
}

export type SlotMeta<S extends SlotId> = SlotMetaMap[S]

/** A single UI entry declared by a plugin. `module` is a relative path under
 *  the plugin's built asset root (e.g. `./Dashboard.js`). */
export interface UIEntry<S extends SlotId = SlotId> {
  slot: S
  id: string
  module: string
  meta: SlotMeta<S>
  requires?: string
}

export interface UIDefinition {
  apiVersion?: '1'
  /** Absolute filesystem path to the plugin's built asset root. Set via
   *  `new URL('../dist/ui', import.meta.url).pathname` inside the plugin. */
  assetsDir?: string
  entries: UIEntry[]
}
