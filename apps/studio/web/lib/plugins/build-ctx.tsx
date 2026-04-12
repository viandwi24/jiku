'use client'

// Builds a vanilla PluginContext object (no host React hooks — plugin has its
// own React). All methods are plain callbacks; plugins use `usePluginQuery` /
// `usePluginMutation` from @jiku/kit/ui for reactive fetching.

import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { useMemo } from 'react'
import type { StudioPluginContext } from '@jiku-plugin/studio'
import { pluginUiApi } from './api-client'
import { getAuthHeaders } from '../auth'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

async function studioFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? path : '/' + path}`
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error?: string }).error ?? `${method} ${path} failed (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export interface PluginContextInput {
  pluginId: string
  pluginVersion: string
  project: { id: string; slug: string; name: string }
  user: { id: string; role: 'owner' | 'admin' | 'member' }
  userPermissions: Set<string>
  agent?: { id: string; slug: string; name: string }
  conversation?: { id: string; mode: 'chat' | 'task' }
}

// Return type widened to `StudioPluginContext` because this factory always
// runs inside Studio — plugin UI components typed with
// `StudioComponentProps` see `ctx.studio` without casting.
export function usePluginContextFactory(input: PluginContextInput): StudioPluginContext {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const themeMode = (resolvedTheme === 'dark' ? 'dark' : 'light') as 'light' | 'dark'

  return useMemo<StudioPluginContext>(() => {
    const { pluginId, project, user, userPermissions } = input

    const api = {
      query: async <T,>(op: string, inputBody?: unknown): Promise<T> => {
        const method = inputBody === undefined ? 'GET' : 'POST'
        return (await pluginUiApi.apiCall(pluginId, project.id, op, method, inputBody)) as T
      },
      mutate: async <T,>(op: string, inputBody?: unknown): Promise<T> => {
        return (await pluginUiApi.apiCall(pluginId, project.id, op, 'POST', inputBody)) as T
      },
      stream: async function*<T>(_op: string, _inputBody?: unknown): AsyncIterable<T> {
        throw new Error('ctx.api.stream not yet implemented')
      },
    }

    const tools = {
      list: async () => {
        const r = await pluginUiApi.toolsList(pluginId, project.id)
        return r.tools
      },
      invoke: async <T,>(toolId: string, inputBody: unknown): Promise<T> => {
        const r = await pluginUiApi.toolInvoke(pluginId, project.id, toolId, inputBody)
        return r.result as T
      },
    }

    const storage = {
      get: async <T,>(key: string): Promise<T | null> => {
        const r = await pluginUiApi.storageGet(pluginId, project.id, key)
        return (r.value ?? null) as T | null
      },
      set: async <T,>(key: string, value: T) => {
        await pluginUiApi.storageSet(pluginId, project.id, key, value)
      },
      delete: async (key: string) => {
        await pluginUiApi.storageDelete(pluginId, project.id, key)
      },
      list: async (prefix?: string) => {
        const r = await pluginUiApi.storageKeys(pluginId, project.id, prefix)
        return r.keys
      },
    }

    const ui = {
      toast: (opts: { title: string; description?: string; variant?: 'default' | 'success' | 'error' | 'warning' }) => {
        const fn =
          opts.variant === 'error' ? toast.error
            : opts.variant === 'success' ? toast.success
            : opts.variant === 'warning' ? toast.warning
            : toast
        fn(opts.title, { description: opts.description })
      },
      confirm: async (opts: { title: string; description?: string; destructive?: boolean }) => {
        if (typeof window === 'undefined') return false
        return window.confirm(`${opts.title}${opts.description ? `\n\n${opts.description}` : ''}`)
      },
      openModal: async <T,>(_modalId: string, _props?: unknown): Promise<T> => {
        throw new Error('ctx.ui.openModal not yet implemented')
      },
      closeModal: () => {},
      navigate: (to: string) => router.push(to),
      openPluginPage: (openPluginId: string, subPath?: string) => {
        const current = window.location.pathname
        // Resolve the company+project segment from current path, e.g.
        //   /studio/companies/<c>/projects/<p>/...
        const m = current.match(/^(\/studio\/companies\/[^/]+\/projects\/[^/]+)\//)
        const base = m ? m[1]! : ''
        router.push(`${base}/plugin-pages/${openPluginId}${subPath ? '/' + subPath : ''}`)
      },
      theme: { mode: themeMode, tokens: {} },
    }

    const events = {
      emit: () => {},
      on: (_topic: string, _handler: (payload: unknown) => void) => () => {},
    }

    const studio = {
      api: {
        get: <T,>(path: string) => studioFetch<T>('GET', path),
        post: <T,>(path: string, body?: unknown) => studioFetch<T>('POST', path, body),
        put: <T,>(path: string, body?: unknown) => studioFetch<T>('PUT', path, body),
        patch: <T,>(path: string, body?: unknown) => studioFetch<T>('PATCH', path, body),
        delete: <T,>(path: string) => studioFetch<T>('DELETE', path),
      },
      baseUrl: API_BASE,
    }

    const permissions = {
      has: (p: string) => userPermissions.has(p),
      require: (p: string) => {
        if (!userPermissions.has(p)) throw new Error(`Missing permission: ${p}`)
      },
    }

    const log = {
      info: (msg: string, meta?: Record<string, unknown>) => console.log(`[plugin:${pluginId}]`, msg, meta ?? ''),
      warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[plugin:${pluginId}]`, msg, meta ?? ''),
      error: (msg: string, meta?: Record<string, unknown>) => console.error(`[plugin:${pluginId}]`, msg, meta ?? ''),
    }

    const ctx: StudioPluginContext = {
      plugin: { id: pluginId, version: input.pluginVersion },
      project: { id: project.id, slug: project.slug, name: project.name },
      agent: input.agent,
      conversation: input.conversation,
      user,
      api,
      tools,
      files: {
        list: async () => [],
        readText: async () => '',
        write: async () => { throw new Error('ctx.files.write not yet wired') },
        search: async () => [],
      },
      storage,
      secrets: {
        get: async () => null,
        set: async () => { throw new Error('ctx.secrets.set not yet wired') },
        delete: async () => { throw new Error('ctx.secrets.delete not yet wired') },
      },
      ui,
      events,
      studio,
      permissions,
      log,
    }
    return ctx
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.pluginId, input.pluginVersion, input.project.id, input.user.id, themeMode])
}
