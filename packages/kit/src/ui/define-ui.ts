import type { UIDefinition, UIEntry } from './slots.ts'

/**
 * Declare the UI contributions of a plugin.
 *
 * `assetsDir` must be the absolute filesystem path to the plugin's built UI
 * bundle root. The standard convention is:
 *
 *   import { fileURLToPath } from 'node:url'
 *   import { dirname, join } from 'node:path'
 *   const __dirname = dirname(fileURLToPath(import.meta.url))
 *   defineUI({
 *     assetsDir: join(__dirname, '../dist/ui'),
 *     entries: [{ slot: 'project.page', id: 'dashboard', module: './Dashboard.js', meta: {...} }]
 *   })
 */
export function defineUI(def: { apiVersion?: '1'; assetsDir?: string; entries: UIEntry[] }): UIDefinition {
  return {
    apiVersion: def.apiVersion ?? '1',
    assetsDir: def.assetsDir,
    entries: def.entries,
  }
}
