import { zodToJsonSchema } from 'zod-to-json-schema'
import type { PluginLoader } from '@jiku/core'
import { upsertPlugin, deleteObsoletePlugins } from '@jiku-studio/db'

/**
 * Sync all registered plugin definitions to the DB plugin registry.
 * Upserts all currently loaded plugins, then deletes any DB rows
 * whose plugin ID is no longer in the registry (renamed/removed plugins).
 * project_plugins rows cascade-delete automatically.
 */
export async function seedPluginRegistry(loader: PluginLoader): Promise<void> {
  const allPlugins = loader.getAllPlugins()
  const activeIds: string[] = []

  for (const plugin of allPlugins) {
    let configSchema: Record<string, unknown> = {}
    if (plugin.configSchema) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configSchema = zodToJsonSchema(plugin.configSchema as any) as Record<string, unknown>
      } catch {
        // ignore schema conversion errors
      }
    }

    await upsertPlugin({
      id: plugin.meta.id,
      name: plugin.meta.name,
      description: plugin.meta.description ?? null,
      version: plugin.meta.version,
      author: plugin.meta.author ?? null,
      icon: plugin.meta.icon ?? null,
      category: plugin.meta.category ?? null,
      project_scope: plugin.meta.project_scope ?? false,
      config_schema: configSchema,
    })
    activeIds.push(plugin.meta.id)
  }

  // Remove plugins no longer in the registry (e.g. renamed or uninstalled)
  const removed = await deleteObsoletePlugins(activeIds)
  if (removed.length > 0) {
    console.log(`[jiku] Removed ${removed.length} obsolete plugin(s): ${removed.map(r => r.id).join(', ')}`)
  }

  console.log(`[jiku] Plugin registry synced — ${allPlugins.length} plugin(s)`)
}
