import { eq, and, like, sql } from 'drizzle-orm'
import { db } from '../client.ts'
import { plugin_kv } from '../schema/index.ts'

export async function pluginKvGet(projectId: string, scope: string, key: string): Promise<unknown> {
  const row = await db.query.plugin_kv.findFirst({
    where: and(
      eq(plugin_kv.project_id, projectId),
      eq(plugin_kv.scope, scope),
      eq(plugin_kv.key, key),
    ),
  })
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return row.value }
}

export async function pluginKvSet(projectId: string, scope: string, key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value)
  await db
    .insert(plugin_kv)
    .values({ project_id: projectId, scope, key, value: serialized })
    .onConflictDoUpdate({
      target: [plugin_kv.project_id, plugin_kv.scope, plugin_kv.key],
      set: { value: serialized, updated_at: new Date() },
    })
}

export async function pluginKvDelete(projectId: string, scope: string, key: string): Promise<void> {
  await db.delete(plugin_kv).where(
    and(
      eq(plugin_kv.project_id, projectId),
      eq(plugin_kv.scope, scope),
      eq(plugin_kv.key, key),
    ),
  )
}

export async function pluginKvKeys(projectId: string, scope: string, prefix?: string): Promise<string[]> {
  const rows = await db.query.plugin_kv.findMany({
    where: and(
      eq(plugin_kv.project_id, projectId),
      eq(plugin_kv.scope, scope),
      prefix ? like(plugin_kv.key, `${prefix}%`) : undefined,
    ),
    columns: { key: true },
  })
  return rows.map(r => r.key)
}
