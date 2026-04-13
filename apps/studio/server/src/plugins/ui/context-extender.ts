// Plan 17 — attaches Studio-host runtime values (http, events, connector)
// to each plugin before its setup runs. Types flow through
// `@jiku-plugin/studio`'s `contributes`; this file supplies the actual
// per-plugin bindings.

import type { BasePluginContext } from '@jiku/types'
import type {
  PluginHttpAPI,
  PluginEventsAPI,
  PluginConnectorAPI,
  PluginFileViewAdapterAPI,
  PluginBrowserAdapterAPI,
  ConnectorAdapter,
  BrowserAdapter,
} from '@jiku-plugin/studio'
import { registerPluginRoute } from './http-registry.ts'
import { publish } from './event-bus.ts'
import { registerFileViewAdapter } from './fileViewAdapterRegistry.ts'
import { browserAdapterRegistry } from '../../browser/adapter-registry.ts'

function makeHttp(pluginId: string): PluginHttpAPI {
  return {
    get: (path, handler) => registerPluginRoute(pluginId, 'get', path, handler),
    post: (path, handler) => registerPluginRoute(pluginId, 'post', path, handler),
    put: (path, handler) => registerPluginRoute(pluginId, 'put', path, handler),
    patch: (path, handler) => registerPluginRoute(pluginId, 'patch', path, handler),
    delete: (path, handler) => registerPluginRoute(pluginId, 'delete', path, handler),
  }
}

function makeEvents(pluginId: string): PluginEventsAPI {
  return {
    emit: (topic, payload, opts) => {
      const projectId = opts?.projectId ?? '*'
      if (projectId === '*') {
        console.warn(`[plugin:${pluginId}] events.emit("${topic}") called without projectId — skipped`)
        return
      }
      publish({ pluginId, projectId, topic, payload })
    },
  }
}

/** Wires `ctx.connector.register(adapter)` via the existing `connector:register`
 *  hook. The Studio server listens for that hook in `apps/studio/server/src/index.ts`
 *  and forwards adapters into `connectorRegistry`. */
function makeConnector(baseCtx: BasePluginContext): PluginConnectorAPI {
  return {
    register: (adapter: ConnectorAdapter) => {
      baseCtx.hooks.callHook('connector:register', adapter).catch(() => {})
    },
  }
}

function makeFileViewAdapters(pluginId: string): PluginFileViewAdapterAPI {
  return {
    register: (spec) => registerFileViewAdapter(pluginId, spec),
  }
}

/** Wires `ctx.browser.register(adapter)` into the global browser adapter
 *  registry (Plan 20). Every project resolves adapters out of this registry
 *  when executing browser tool calls or ping/preview actions. */
function makeBrowserAdapter(_pluginId: string): PluginBrowserAdapterAPI {
  return {
    register: (adapter: BrowserAdapter) => browserAdapterRegistry.register(adapter),
  }
}

export function extendPluginContext(pluginId: string, baseCtx: BasePluginContext): BasePluginContext {
  const extended = {
    ...baseCtx,
    http: makeHttp(pluginId),
    events: makeEvents(pluginId),
    connector: makeConnector(baseCtx),
    fileViewAdapters: makeFileViewAdapters(pluginId),
    browser: makeBrowserAdapter(pluginId),
  }
  return extended as BasePluginContext
}
