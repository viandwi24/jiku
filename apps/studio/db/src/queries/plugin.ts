import { eq, and } from 'drizzle-orm'
import { db } from '../client.ts'
import { plugins, project_plugins } from '../schema/plugins.ts'

// Plugin registry queries

export async function getAllPluginRows() {
  return db.select().from(plugins)
}

export async function getPluginById(id: string) {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id))
  return row ?? null
}

export async function upsertPlugin(data: {
  id: string
  name: string
  description?: string | null
  version: string
  author?: string | null
  icon?: string | null
  category?: string | null
  project_scope?: boolean
  config_schema?: Record<string, unknown>
}) {
  const [row] = await db
    .insert(plugins)
    .values({
      ...data,
      project_scope: data.project_scope ?? false,
      config_schema: data.config_schema ?? {},
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: plugins.id,
      set: {
        name: data.name,
        description: data.description,
        version: data.version,
        author: data.author,
        icon: data.icon,
        category: data.category,
        project_scope: data.project_scope ?? false,
        config_schema: data.config_schema ?? {},
        updated_at: new Date(),
      },
    })
    .returning()
  return row
}

// Project plugin queries

export async function getProjectPlugins(projectId: string) {
  return db
    .select({
      id: project_plugins.id,
      project_id: project_plugins.project_id,
      plugin_id: project_plugins.plugin_id,
      enabled: project_plugins.enabled,
      config: project_plugins.config,
      activated_at: project_plugins.activated_at,
      updated_at: project_plugins.updated_at,
      // Plugin info
      plugin_name: plugins.name,
      plugin_description: plugins.description,
      plugin_version: plugins.version,
      plugin_author: plugins.author,
      plugin_icon: plugins.icon,
      plugin_category: plugins.category,
      plugin_project_scope: plugins.project_scope,
      plugin_config_schema: plugins.config_schema,
    })
    .from(project_plugins)
    .innerJoin(plugins, eq(project_plugins.plugin_id, plugins.id))
    .where(eq(project_plugins.project_id, projectId))
}

export async function getProjectPluginRow(projectId: string, pluginId: string) {
  const [row] = await db
    .select()
    .from(project_plugins)
    .where(and(
      eq(project_plugins.project_id, projectId),
      eq(project_plugins.plugin_id, pluginId),
    ))
  return row ?? null
}

export async function getEnabledProjectPlugins(projectId: string) {
  return db
    .select({
      id: project_plugins.id,
      project_id: project_plugins.project_id,
      plugin_id: project_plugins.plugin_id,
      enabled: project_plugins.enabled,
      config: project_plugins.config,
      activated_at: project_plugins.activated_at,
    })
    .from(project_plugins)
    .where(and(
      eq(project_plugins.project_id, projectId),
      eq(project_plugins.enabled, true),
    ))
}

export async function enablePlugin(projectId: string, pluginId: string, config: Record<string, unknown>) {
  const [row] = await db
    .insert(project_plugins)
    .values({
      project_id: projectId,
      plugin_id: pluginId,
      enabled: true,
      config,
      activated_at: new Date(),
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: [project_plugins.project_id, project_plugins.plugin_id],
      set: {
        enabled: true,
        config,
        activated_at: new Date(),
        updated_at: new Date(),
      },
    })
    .returning()
  return row
}

export async function disablePlugin(projectId: string, pluginId: string) {
  const [row] = await db
    .update(project_plugins)
    .set({ enabled: false, updated_at: new Date() })
    .where(and(
      eq(project_plugins.project_id, projectId),
      eq(project_plugins.plugin_id, pluginId),
    ))
    .returning()
  return row
}

export async function updatePluginConfig(projectId: string, pluginId: string, config: Record<string, unknown>) {
  const [row] = await db
    .update(project_plugins)
    .set({ config, updated_at: new Date() })
    .where(and(
      eq(project_plugins.project_id, projectId),
      eq(project_plugins.plugin_id, pluginId),
    ))
    .returning()
  return row
}
