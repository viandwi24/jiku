import type { PluginUIEntry } from '@jiku/types'
import { getAuthHeaders } from '../auth'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export interface RegistryPlugin {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  author?: string
  category?: string
  apiVersion: string
  enabled: boolean
  grantedPermissions: string[]
  uiEntries: PluginUIEntry[]
}

export interface RegistryResponse {
  apiVersion: '1'
  plugins: RegistryPlugin[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error?: string }).error ?? 'Request failed')
  }
  return res.json() as Promise<T>
}

export const pluginUiApi = {
  registry: (projectId: string) =>
    request<RegistryResponse>(`/api/plugins/ui-registry?project=${projectId}`),

  storageGet: (pluginId: string, projectId: string, key: string) =>
    request<{ value: unknown }>(
      `/api/plugins/${pluginId}/storage?project=${projectId}&key=${encodeURIComponent(key)}`,
    ),
  storageSet: (pluginId: string, projectId: string, key: string, value: unknown) =>
    request<{ ok: true }>(`/api/plugins/${pluginId}/storage`, {
      method: 'PUT',
      body: JSON.stringify({ project: projectId, key, value }),
    }),
  storageDelete: (pluginId: string, projectId: string, key: string) =>
    request<{ ok: true }>(
      `/api/plugins/${pluginId}/storage?project=${projectId}&key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),
  storageKeys: (pluginId: string, projectId: string, prefix?: string) => {
    const qs = new URLSearchParams({ project: projectId })
    if (prefix) qs.set('prefix', prefix)
    return request<{ keys: string[] }>(`/api/plugins/${pluginId}/storage/keys?${qs}`)
  },

  toolsList: (pluginId: string, projectId: string) =>
    request<{ tools: Array<{ id: string; name: string; description: string; plugin_id: string }> }>(
      `/api/plugins/${pluginId}/tools?project=${projectId}`,
    ),
  toolInvoke: (pluginId: string, projectId: string, toolId: string, input: unknown) =>
    request<{ result: unknown }>(
      `/api/plugins/${pluginId}/tools/${encodeURIComponent(toolId)}/invoke`,
      { method: 'POST', body: JSON.stringify({ project: projectId, input }) },
    ),

  apiCall: (pluginId: string, projectId: string, op: string, method: 'GET' | 'POST', input?: unknown) => {
    const path = op.startsWith('/') ? op : `/${op}`
    const url = `/api/plugins/${pluginId}/api${path}?project=${projectId}`
    return request<unknown>(url, {
      method,
      body: method === 'GET' ? undefined : JSON.stringify(input ?? {}),
    })
  },

  inspector: (pluginId: string) =>
    request<{ plugin: unknown; routes: Array<{ method: string; path: string }>; metrics: Record<string, unknown> }>(
      `/api/plugins/${pluginId}/inspector`,
    ),

  audit: (projectId?: string, pluginId?: string) => {
    const qs = new URLSearchParams()
    if (projectId) qs.set('project', projectId)
    if (pluginId) qs.set('plugin', pluginId)
    return request<{ entries: Array<Record<string, unknown>> }>(`/api/plugins/audit?${qs}`)
  },
}

export function eventsUrl(pluginId: string, projectId: string, token: string): string {
  const qs = new URLSearchParams({ project: projectId, token })
  return `${BASE_URL}/api/plugins/${pluginId}/events?${qs}`
}
