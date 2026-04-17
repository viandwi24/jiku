// @jiku-plugin/studio — Studio host anchor.
//
// Purpose: expose Studio-host-provided instance types through the plugin
// system's `contributes` + `depends` mechanism. Any plugin that declares
// `depends: [StudioPlugin]` gets `ctx.http`, `ctx.events` (and future
// additions like `ctx.db`) typed and bound automatically.
//
// No module augmentation. No runtime behavior here — the actual per-plugin
// bindings are injected by the Studio server's context-extender (which is
// why `contributes` just returns an empty object: the runtime values come
// from the extender, the types come from the declared contributes shape).
//
// For plugin UI components, use the `StudioComponentProps` / `StudioPluginContext`
// exported below as the prop type — browser-side `ctx.studio.api` becomes typed.

import { definePlugin } from '@jiku/kit'
import type { PluginComponentProps, PluginContext } from '@jiku/kit/ui'
import type {
  PluginHttpAPI,
  PluginEventsAPI,
  PluginStudioHost,
  PluginConnectorAPI,
  PluginFileViewAdapterAPI,
  PluginBrowserAdapterAPI,
  PluginConsoleAPI,
} from './types.ts'

// ─── Type exports ────────────────────────────────────────────────────────────

export type {
  PluginHttpMethod,
  PluginHttpHandlerCtx,
  PluginHttpHandlerFn,
  PluginHttpAPI,
  PluginEventsAPI,
  PluginStudioApi,
  PluginStudioHost,
  PluginConnectorAPI,
  ConnectorAdapter,
  FileViewAdapterSpec,
  PluginFileViewAdapterAPI,
  PluginBrowserAdapterAPI,
  PluginConsoleAPI,
  PluginConsoleLogger,
  BrowserAdapter,
} from './types.ts'

/** Studio-host PluginContext — extends the base with `studio.*` surface. */
export interface StudioPluginContext extends PluginContext {
  studio: PluginStudioHost
}

/** Prop type for plugin UI components that render under Jiku Studio. */
export type StudioComponentProps = PluginComponentProps<StudioPluginContext>

// ─── Plugin anchor ───────────────────────────────────────────────────────────
//
// `contributes` here declares the *shape* of what a Studio host injects into
// every depending plugin's setup `ctx`. The runtime values are attached by
// the Studio server's context-extender (apps/studio/server/src/plugins/ui/
// context-extender.ts). We return `{}` at runtime on purpose — that empty
// object is cached and spread into dependents, so the extender's real http/
// events bindings survive (merge order in the loader keeps extender first,
// contributes last, and contributes has no runtime keys to clobber).

interface StudioContributes {
  http: PluginHttpAPI
  events: PluginEventsAPI
  connector: PluginConnectorAPI
  fileViewAdapters: PluginFileViewAdapterAPI
  browser: PluginBrowserAdapterAPI
  console: PluginConsoleAPI
}

const StudioPlugin = definePlugin({
  meta: {
    id: 'jiku.studio',
    name: 'Jiku Studio (host)',
    version: '1.0.0',
    description: 'Type anchor for Jiku Studio host surfaces — http, events, studio. No runtime behavior.',
    author: 'Jiku',
    icon: '🏠',
    category: 'system',
  },

  // Types-only contract — real per-plugin bindings are injected by the
  // Studio server's context-extender before setup runs. Runtime value stays
  // empty so the loader's merge doesn't clobber the extender's bindings.
  contributes: () => ({} as unknown as StudioContributes),

  setup() {
    // Intentionally empty.
  },
})

export default StudioPlugin
export { StudioPlugin }
