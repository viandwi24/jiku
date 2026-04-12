import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { discoverPluginsFromFolder, type DiscoveredPlugin } from '@jiku/core'
import { findWorkspaceRoot } from './workspace.ts'

export interface PluginRow extends DiscoveredPlugin {
  /** Whether `dist/ui/` exists (= plugin has been built at least once). */
  built: boolean
  /** Count of UI entries from its manifest. */
  uiEntries: number
}

async function folderExists(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isDirectory() } catch { return false }
}

export async function listPlugins(): Promise<PluginRow[]> {
  const ws = await findWorkspaceRoot()
  const discovered = await discoverPluginsFromFolder(ws.pluginsDir, { verbose: false })
  const rows: PluginRow[] = []
  for (const d of discovered) {
    const distUi = join(d.dir, 'dist', 'ui')
    rows.push({
      ...d,
      built: await folderExists(distUi),
      uiEntries: d.def.ui?.entries?.length ?? 0,
    })
  }
  rows.sort((a, b) => a.def.meta.id.localeCompare(b.def.meta.id))
  return rows
}

export async function findPlugin(idOrName: string): Promise<PluginRow | null> {
  const rows = await listPlugins()
  return rows.find(r => r.def.meta.id === idOrName || r.packageName === idOrName) ?? null
}

/**
 * If the current working directory lives inside a plugin folder (i.e. cwd is
 * `plugins/<id>/...`), return that plugin. Otherwise null — callers should
 * treat that as "operate on all plugins".
 *
 * This lets `jiku plugin build` scope to a single plugin when the user runs
 * the command from inside its folder, without needing to pass an id.
 */
export async function detectCwdPlugin(cwd: string = process.cwd()): Promise<PluginRow | null> {
  const ws = await findWorkspaceRoot(cwd).catch(() => null)
  if (!ws) return null
  const pluginsDir = resolve(ws.pluginsDir) + sep
  const abs = resolve(cwd)
  if (!abs.startsWith(pluginsDir)) return null
  const rows = await listPlugins()
  return rows.find(r => abs === r.dir || abs.startsWith(r.dir + sep)) ?? null
}
