// PluginContext — the surface each plugin UI component receives.
// Locked at apiVersion "1". Additive-only within a major.

export type PluginApiVersion = '1'
export type ThemeMode = 'light' | 'dark'

export interface FileEntry {
  path: string
  name: string
  size: number
  mime_type?: string
  is_dir: boolean
  updated_at: string
}

export interface ToolInfo {
  id: string
  name: string
  description: string
  plugin_id: string
}

export interface QueryOpts {
  enabled?: boolean
  staleTime?: number
  refetchOnWindowFocus?: boolean
}

export interface QueryResult<T> {
  data: T | undefined
  error: Error | null
  isLoading: boolean
  isFetching: boolean
  refetch: () => Promise<void>
}

export interface MutationResult<T, V> {
  data: T | undefined
  error: Error | null
  isPending: boolean
  mutate: (input: V) => void
  mutateAsync: (input: V) => Promise<T>
  reset: () => void
}

export interface ToastOpts {
  title: string
  description?: string
  variant?: 'default' | 'success' | 'error' | 'warning'
}

export interface ConfirmOpts {
  title: string
  description?: string
  destructive?: boolean
  confirmLabel?: string
  cancelLabel?: string
}

export interface PluginContext {
  // ─── Identity ──────────────────────────────────────────
  plugin: { id: string; version: string }
  project: { id: string; slug: string; name: string }
  agent?: { id: string; slug: string; name: string }
  conversation?: { id: string; mode: 'chat' | 'task' }
  user: { id: string; role: 'owner' | 'admin' | 'member' }

  // ─── Plugin API (namespaced to /api/plugins/:id/api/*) ─
  // Plain callbacks only — plugins bundle their own React, so host hooks
  // (TanStack Query) can't be shared across instances. Use `usePluginQuery`
  // from @jiku/kit/ui for reactive fetching.
  api: {
    query<T = unknown>(op: string, input?: unknown): Promise<T>
    mutate<T = unknown>(op: string, input?: unknown): Promise<T>
    stream<T = unknown>(op: string, input?: unknown): AsyncIterable<T>
  }

  // Host-specific surfaces (e.g. Studio's `ctx.studio.api`) are added via
  // TypeScript module augmentation by the owning host package. Plugins that
  // target Studio should `import { StudioPlugin } from '@jiku-plugin/studio'`
  // to pull in those types.

  // ─── Tools ─────────────────────────────────────────────
  tools: {
    list(filter?: { plugin?: string }): Promise<ToolInfo[]>
    invoke<T = unknown>(toolId: string, input: unknown): Promise<T>
  }

  // ─── Filesystem (Plan 16) ──────────────────────────────
  files: {
    list(path: string): Promise<FileEntry[]>
    readText(path: string): Promise<string>
    write(path: string, data: string, opts?: { expectedVersion?: number }): Promise<FileEntry>
    search(query: string): Promise<FileEntry[]>
  }

  // ─── Storage KV (per plugin × project) ─────────────────
  storage: {
    get<T = unknown>(key: string): Promise<T | null>
    set<T = unknown>(key: string, value: T): Promise<void>
    delete(key: string): Promise<void>
    list(prefix?: string): Promise<string[]>
  }

  // ─── Secrets ───────────────────────────────────────────
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }

  // ─── UI helpers ────────────────────────────────────────
  ui: {
    toast(opts: ToastOpts): void
    confirm(opts: ConfirmOpts): Promise<boolean>
    openModal<T = unknown>(modalId: string, props?: unknown): Promise<T>
    closeModal(result?: unknown): void
    navigate(to: string): void
    openPluginPage(pluginId: string, subPath?: string): void
    theme: { mode: ThemeMode; tokens: Record<string, string> }
  }

  // ─── Events ────────────────────────────────────────────
  events: {
    emit(topic: string, payload?: unknown): void
    on(topic: string, handler: (payload: unknown) => void): () => void
  }

  // ─── Permissions ───────────────────────────────────────
  permissions: {
    has(permission: string): boolean
    require(permission: string): void
  }

  // ─── Telemetry ─────────────────────────────────────────
  log: {
    info(msg: string, meta?: Record<string, unknown>): void
    warn(msg: string, meta?: Record<string, unknown>): void
    error(msg: string, meta?: Record<string, unknown>): void
  }
}

export class PluginPermissionError extends Error {
  constructor(public permission: string) {
    super(`Missing permission: ${permission}`)
    this.name = 'PluginPermissionError'
  }
}
