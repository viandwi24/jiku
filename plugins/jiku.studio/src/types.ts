// Studio-host-specific types. Exported from `@jiku-plugin/studio`.
// These used to live in `@jiku/types` but they're Studio-specific — other
// (non-Studio) hosts would never implement them.

import type { ConnectorAdapter, BrowserAdapter } from '@jiku/kit'
export type { ConnectorAdapter, BrowserAdapter }

/** Connector-registration surface. Connector plugins (Telegram, Discord, etc.)
 *  use `ctx.connector.register(adapter)` to install their `ConnectorAdapter`
 *  into the Studio connector registry. */
export interface PluginConnectorAPI {
  register: (adapter: ConnectorAdapter) => void
}

export type PluginHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

export interface PluginHttpHandlerCtx {
  projectId: string
  userId: string
  pluginId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: any
  /** Read a raw project file as Buffer. Injected by the Studio server. */
  readProjectFile?: (path: string) => Promise<Buffer | null>
}

export type PluginHttpHandlerFn = (ctx: PluginHttpHandlerCtx) => Promise<unknown> | unknown

export interface PluginHttpAPI {
  get: (path: string, handler: PluginHttpHandlerFn) => void
  post: (path: string, handler: PluginHttpHandlerFn) => void
  put: (path: string, handler: PluginHttpHandlerFn) => void
  patch: (path: string, handler: PluginHttpHandlerFn) => void
  delete: (path: string, handler: PluginHttpHandlerFn) => void
}

export interface PluginEventsAPI {
  /** Emit to project-scoped subscribers. `projectId` is required server-side. */
  emit: (topic: string, payload?: unknown, opts?: { projectId?: string }) => void
}

/** Spec for a plugin-contributed file view adapter. */
export interface FileViewAdapterSpec {
  /** Unique ID for this adapter, e.g. `jiku.sheet.spreadsheet` */
  id: string
  /** Display label in the "View as" selector */
  label: string
  /** Lowercase file extensions this adapter handles, e.g. `['.csv', '.xlsx']` */
  extensions: string[]
}

/** Plugin API for registering file view adapters. */
export interface PluginFileViewAdapterAPI {
  register: (spec: FileViewAdapterSpec) => void
}

/** Console feature — ephemeral log streams per instance id.
 *  Usage: `const con = ctx.console.get('jiku.telegram.bot:connector:abc')`;
 *         `con.info('connected', { bot: 'mybot' })`. Logs are held 100–200 in
 *         memory, batched to a tempfile per session, and streamed to the
 *         Studio UI via SSE. See `<ConsolePanel>` on the UI side. */
export interface PluginConsoleLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
  debug: (msg: string, meta?: Record<string, unknown>) => void
}

export interface PluginConsoleAPI {
  /** Get (or lazily create) a console by id. Title is optional label for UI. */
  get: (id: string, title?: string) => PluginConsoleLogger
  /** Drop the console — clears memory + file. Optional cleanup on deactivate. */
  drop: (id: string) => Promise<void>
}

/** Plugin API for registering browser adapters (Plan 20).
 *  Installed adapters appear in the Browser Profile adapter selector UI. */
export interface PluginBrowserAdapterAPI {
  register: (adapter: BrowserAdapter) => void
}

/** Browser-side: direct passthrough to any Studio REST endpoint as the current user. */
export interface PluginStudioApi {
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  put<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  delete<T = unknown>(path: string): Promise<T>
}

export interface PluginStudioHost {
  api: PluginStudioApi
  /** e.g. `http://localhost:3001` — useful for raw URLs (SSE, images). */
  baseUrl: string
}
