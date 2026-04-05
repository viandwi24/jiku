import { zodToJsonSchema } from 'zod-to-json-schema'
import type { PluginLoader } from '@jiku/core'
import { upsertPlugin } from '@jiku-studio/db'

/**
 * Sync all registered plugin definitions to the DB plugin registry.
 * Called on server boot so the UI can list all available plugins.
 */
export async function seedPluginRegistry(loader: PluginLoader): Promise<void> {
  const allPlugins = loader.getAllPlugins()

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
  }

  console.log(`[jiku] Plugin registry synced — ${allPlugins.length} plugin(s)`)
}
