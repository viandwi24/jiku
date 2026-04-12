// Plan 17 — server-side aggregator for the Plugin UI manifest.
// Emits `assetUrl` per entry so the browser can dynamic-import the bundle.

import type { PluginLoader } from '@jiku/core'
import type { PluginUIEntry } from '@jiku/types'
import { getProjectPlugins } from '@jiku-studio/db'
import { runtimeManager } from '../../runtime/manager.ts'
import { signAsset } from './signer.ts'

export interface RegistryUIEntry extends PluginUIEntry {
  /** Browser-reachable URL for the compiled ESM bundle. */
  assetUrl: string
}

export interface PluginRegistryEntry {
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
  uiEntries: RegistryUIEntry[]
}

export interface PluginUIRegistryResponse {
  apiVersion: '1'
  plugins: PluginRegistryEntry[]
}

function toAssetUrl(pluginId: string, modulePath: string): string {
  // Normalize './Dashboard.js' → 'Dashboard.js' and attach a short-lived
  // HMAC signature (validated by the asset router). Re-minted every time
  // the registry is fetched.
  const clean = modulePath.replace(/^\.\//, '')
  const { sig, exp } = signAsset(pluginId, clean)
  const qs = new URLSearchParams({ sig, exp: String(exp) })
  return `/api/plugins/${pluginId}/ui/${clean}?${qs.toString()}`
}

export async function buildUIRegistry(projectId: string): Promise<PluginUIRegistryResponse> {
  const loader: PluginLoader | null = runtimeManager.getPluginLoader()
  const defs = loader?.getAllPlugins() ?? []
  const projectRows = await getProjectPlugins(projectId)
  const byId = new Map(projectRows.map(r => [r.plugin_id, r]))

  const plugins: PluginRegistryEntry[] = defs
    .filter(def => def.ui?.entries?.length)
    .map(def => {
      const pp = byId.get(def.meta.id)
      const isSystem = !def.meta.project_scope
      const enabled = isSystem ? true : (pp?.enabled ?? false)
      const entries: RegistryUIEntry[] = (def.ui?.entries ?? []).map(e => ({
        ...e,
        assetUrl: toAssetUrl(def.meta.id, e.module),
      }))
      return {
        id: def.meta.id,
        name: def.meta.name,
        version: def.meta.version,
        description: def.meta.description,
        icon: def.meta.icon,
        author: def.meta.author,
        category: def.meta.category,
        apiVersion: def.ui?.apiVersion ?? '1',
        enabled,
        grantedPermissions: (pp?.granted_permissions as string[] | null) ?? [],
        uiEntries: entries,
      }
    })

  return { apiVersion: '1', plugins }
}
