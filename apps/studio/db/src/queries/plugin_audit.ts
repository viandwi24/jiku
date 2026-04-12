import { desc, eq, and } from 'drizzle-orm'
import { db } from '../client.ts'
import { plugin_audit_log, type NewPluginAuditLog, type PluginAuditLog } from '../schema/plugin_audit_log.ts'

export async function writeAuditLog(entry: NewPluginAuditLog): Promise<void> {
  await db.insert(plugin_audit_log).values(entry)
}

export async function listAuditLog(params: {
  projectId?: string
  pluginId?: string
  limit?: number
}): Promise<PluginAuditLog[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500)
  const conds = []
  if (params.projectId) conds.push(eq(plugin_audit_log.project_id, params.projectId))
  if (params.pluginId) conds.push(eq(plugin_audit_log.plugin_id, params.pluginId))
  return db
    .select()
    .from(plugin_audit_log)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(plugin_audit_log.created_at))
    .limit(limit)
}
