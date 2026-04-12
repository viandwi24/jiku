// Plan 17 — filesystem-based plugin discovery.
//
// Scans a folder for plugin packages, dynamic-imports each, and returns
// valid PluginDefinition instances. This is the single gateway that both the
// server runtime and the Studio Plugin UI registry flow through — no plugin
// is visible anywhere in the system unless it's discovered here.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PluginDefinition, ContributesValue } from '@jiku/types'

export interface DiscoveredPlugin {
  dir: string
  packageName: string
  entryFile: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: PluginDefinition<any>
}

export interface DiscoverOptions {
  /** Relative paths (to rootDir) or plugin ids to skip. */
  exclude?: string[]
  /** Print diagnostics to console. Default true. */
  verbose?: boolean
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Discover plugin definitions in `rootDir`. Each subdirectory must contain a
 * `package.json` with a `module` or `main` field pointing to the plugin entry.
 * The entry must default-export a `PluginDefinition`.
 */
export async function discoverPluginsFromFolder(
  rootDir: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredPlugin[]> {
  const verbose = opts.verbose ?? true
  const exclude = new Set(opts.exclude ?? [])
  const abs = resolve(rootDir)

  let entries: string[]
  try {
    entries = await readdir(abs)
  } catch (err) {
    console.warn(`[plugin-loader] Cannot read ${abs}:`, err instanceof Error ? err.message : err)
    return []
  }

  const results: DiscoveredPlugin[] = []
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue
    if (exclude.has(name)) continue

    const dir = join(abs, name)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue

    const pkg = await readJson(join(dir, 'package.json'))
    if (!pkg) {
      if (verbose) console.log(`[plugin-loader] skip "${name}" — no package.json`)
      continue
    }
    const packageName = typeof pkg['name'] === 'string' ? pkg['name'] : name
    if (exclude.has(packageName)) continue

    const entryRel = (pkg['module'] as string | undefined)
      ?? (pkg['main'] as string | undefined)
      ?? 'src/index.ts'
    const entryAbs = join(dir, entryRel)

    let mod: { default?: unknown }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = (await import(entryAbs)) as any
    } catch (err) {
      console.warn(`[plugin-loader] Failed to import "${packageName}" (${entryAbs}):`, err instanceof Error ? err.message : err)
      continue
    }

    const def = mod.default as PluginDefinition<ContributesValue> | undefined
    if (!def || typeof def !== 'object' || !def.meta?.id) {
      if (verbose) console.warn(`[plugin-loader] skip "${packageName}" — default export is not a PluginDefinition`)
      continue
    }

    if (exclude.has(def.meta.id)) continue

    results.push({ dir, packageName, entryFile: entryAbs, def })
    if (verbose) {
      const uiCount = def.ui?.entries?.length ?? 0
      console.log(`[plugin-loader] ✓ discovered ${def.meta.id} v${def.meta.version}${uiCount > 0 ? ` (${uiCount} UI entries)` : ''}`)
    }
  }

  return results
}
