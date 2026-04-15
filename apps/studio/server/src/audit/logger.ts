import type { Request } from 'express'
import { insertAuditLog } from '@jiku-studio/db'

/**
 * Plan 18 — broad audit logger. Fire-and-forget: never blocks the request.
 *
 * `auditContext(req)` extracts actor + IP + UA from an Express request. Route
 * handlers pass it to one of the `audit.*` helpers to record a structured
 * event. Writes go to the `audit_logs` table via insertAuditLog.
 */

export type ActorType = 'user' | 'agent' | 'system' | 'connector'

export interface AuditContext {
  actor_id: string | null
  actor_type?: ActorType
  project_id?: string | null
  company_id?: string | null
  ip_address?: string | null
  user_agent?: string | null
}

export type AuditEventType =
  | 'tool.invoke'
  | 'tool.blocked'
  | 'file.write'
  | 'file.delete'
  | 'file.read'
  | 'secret.get'
  | 'secret.create'
  | 'secret.delete'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'auth.register'
  | 'member.invite'
  | 'member.remove'
  | 'member.role_changed'
  | 'permission.granted'
  | 'permission.revoked'
  | 'plugin.activated'
  | 'plugin.deactivated'
  | 'agent.created'
  | 'agent.deleted'
  // Plan 19 — memory learning loop
  | 'memory.write'
  | 'memory.flush'
  | 'memory.reflection_run'
  | 'memory.dream_run'
  // Plan 19 — skills loader v2
  | 'skill.activate'
  | 'skill.read_file'
  | 'skill.import'
  | 'skill.source_changed'
  | 'skill.assignment_changed'
  // Plan 24 — commands
  | 'command.invoke'
  | 'command.assignment_changed'
  | 'command.source_changed'
  // Plan 25 — @file reference hint
  | 'reference.scan'
  // FS tool permission
  | 'fs.permission_set'
  | 'fs.permission_denied'
  // Plan 24 — connector interactive setup
  | 'credential.setup_started'
  | 'credential.setup_step'
  | 'credential.setup_completed'
  | 'credential.setup_failed'
  | 'credential.setup_cancelled'
  // Plan 25 — Action Request Center
  | 'action_request.created'
  | 'action_request.viewed'
  | 'action_request.responded'
  | 'action_request.dropped'
  | 'action_request.expired'
  | 'action_request.executed'
  | 'action_request.execution_failed'

interface WriteEntry extends AuditContext {
  event_type: AuditEventType
  resource_type: string
  resource_id?: string | null
  resource_name?: string | null
  metadata?: Record<string, unknown>
}

export function auditContext(req: Request): AuditContext {
  const userId = (req.res?.locals?.['user_id'] as string | undefined) ?? null
  return {
    actor_id: userId,
    actor_type: userId ? 'user' : 'system',
    ip_address: req.ip ?? null,
    user_agent: req.get('user-agent') ?? null,
  }
}

// Plan 22 revision — guard non-UUID actor ids (e.g. "connector:<uuid>", "system")
// so the Postgres UUID column doesn't reject the insert. The original prefix is
// preserved in metadata.actor_label for traceability.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function write(entry: WriteEntry): void {
  let actorId = entry.actor_id ?? null
  let actorType = entry.actor_type ?? (entry.actor_id ? 'user' : 'system')
  let metadata = entry.metadata
  if (actorId && !UUID_RE.test(actorId)) {
    metadata = { ...(metadata ?? {}), actor_label: actorId }
    if (actorId.startsWith('connector:')) actorType = 'connector'
    else if (actorId === 'system') actorType = 'system'
    else actorType = actorType === 'user' ? 'system' : actorType
    actorId = null
  }
  // Fire-and-forget — never block request flow on audit write.
  insertAuditLog({
    project_id: entry.project_id ?? null,
    company_id: entry.company_id ?? null,
    actor_id: actorId,
    actor_type: actorType,
    event_type: entry.event_type,
    resource_type: entry.resource_type,
    resource_id: entry.resource_id ?? null,
    resource_name: entry.resource_name ?? null,
    metadata: metadata ?? {},
    ip_address: entry.ip_address ?? null,
    user_agent: entry.user_agent ?? null,
  }).catch((err) => {
    console.warn('[audit] Failed to write audit log:', err)
  })
}

export const audit = {
  toolInvoke: (ctx: AuditContext, toolId: string, meta?: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'tool.invoke', resource_type: 'tool', resource_id: toolId, metadata: meta }),

  toolBlocked: (ctx: AuditContext, toolId: string, reason: string) =>
    write({ ...ctx, event_type: 'tool.blocked', resource_type: 'tool', resource_id: toolId, metadata: { reason } }),

  fileWrite: (ctx: AuditContext, path: string, sizeBytes: number) =>
    write({ ...ctx, event_type: 'file.write', resource_type: 'file', resource_name: path, metadata: { size_bytes: sizeBytes } }),

  fileDelete: (ctx: AuditContext, path: string) =>
    write({ ...ctx, event_type: 'file.delete', resource_type: 'file', resource_name: path }),

  secretGet: (ctx: AuditContext, credentialId: string, credentialName: string) =>
    write({ ...ctx, event_type: 'secret.get', resource_type: 'credential', resource_id: credentialId, resource_name: credentialName }),

  secretCreate: (ctx: AuditContext, credentialId: string, credentialName: string) =>
    write({ ...ctx, event_type: 'secret.create', resource_type: 'credential', resource_id: credentialId, resource_name: credentialName }),

  secretDelete: (ctx: AuditContext, credentialId: string, credentialName: string) =>
    write({ ...ctx, event_type: 'secret.delete', resource_type: 'credential', resource_id: credentialId, resource_name: credentialName }),

  authLogin: (ctx: AuditContext, email: string, success: boolean) =>
    write({ ...ctx, event_type: success ? 'auth.login' : 'auth.login_failed', resource_type: 'auth', metadata: { email } }),

  authRegister: (ctx: AuditContext, email: string) =>
    write({ ...ctx, event_type: 'auth.register', resource_type: 'auth', metadata: { email } }),

  memberInvite: (ctx: AuditContext, email: string, extra?: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'member.invite', resource_type: 'member', metadata: { email, ...extra } }),

  memberRemove: (ctx: AuditContext, targetUserId: string) =>
    write({ ...ctx, event_type: 'member.remove', resource_type: 'member', resource_id: targetUserId }),

  memberRoleChanged: (ctx: AuditContext, targetUserId: string, roleId: string | null) =>
    write({ ...ctx, event_type: 'member.role_changed', resource_type: 'member', resource_id: targetUserId, metadata: { role_id: roleId } }),

  permissionGranted: (ctx: AuditContext, targetUserId: string, pluginId: string, permission: string) =>
    write({ ...ctx, event_type: 'permission.granted', resource_type: 'permission', resource_id: targetUserId, metadata: { plugin_id: pluginId, permission } }),

  permissionRevoked: (ctx: AuditContext, targetUserId: string, pluginId: string, permission: string) =>
    write({ ...ctx, event_type: 'permission.revoked', resource_type: 'permission', resource_id: targetUserId, metadata: { plugin_id: pluginId, permission } }),

  pluginActivated: (ctx: AuditContext, pluginId: string) =>
    write({ ...ctx, event_type: 'plugin.activated', resource_type: 'plugin', resource_id: pluginId }),

  pluginDeactivated: (ctx: AuditContext, pluginId: string) =>
    write({ ...ctx, event_type: 'plugin.deactivated', resource_type: 'plugin', resource_id: pluginId }),

  agentCreated: (ctx: AuditContext, agentId: string, name: string) =>
    write({ ...ctx, event_type: 'agent.created', resource_type: 'agent', resource_id: agentId, resource_name: name }),

  agentDeleted: (ctx: AuditContext, agentId: string, name: string) =>
    write({ ...ctx, event_type: 'agent.deleted', resource_type: 'agent', resource_id: agentId, resource_name: name }),

  // Plan 19
  memoryWrite: (ctx: AuditContext, memoryId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'memory.write', resource_type: 'memory', resource_id: memoryId, metadata: meta }),

  memoryFlush: (ctx: AuditContext, conversationId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'memory.flush', resource_type: 'conversation', resource_id: conversationId, metadata: meta }),

  memoryReflectionRun: (ctx: AuditContext, conversationId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'memory.reflection_run', resource_type: 'conversation', resource_id: conversationId, metadata: meta }),

  memoryDreamRun: (ctx: AuditContext, phase: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'memory.dream_run', resource_type: 'project', metadata: { phase, ...meta } }),

  // Plan 19 — skills
  skillActivate: (ctx: AuditContext, slug: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'skill.activate', resource_type: 'skill', resource_name: slug, metadata: meta }),

  skillReadFile: (ctx: AuditContext, slug: string, path: string) =>
    write({ ...ctx, event_type: 'skill.read_file', resource_type: 'skill', resource_name: slug, metadata: { path } }),

  skillImport: (ctx: AuditContext, slug: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'skill.import', resource_type: 'skill', resource_name: slug, metadata: meta }),

  skillSourceChanged: (ctx: AuditContext, pluginId: string, action: 'add' | 'remove', meta?: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'skill.source_changed', resource_type: 'plugin', resource_id: pluginId, metadata: { action, ...meta } }),

  skillAssignmentChanged: (ctx: AuditContext, agentId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'skill.assignment_changed', resource_type: 'agent', resource_id: agentId, metadata: meta }),

  // Plan 24 — commands
  commandInvoke: (ctx: AuditContext, slug: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'command.invoke', resource_type: 'command', resource_name: slug, metadata: meta }),

  commandAssignmentChanged: (ctx: AuditContext, agentId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'command.assignment_changed', resource_type: 'agent', resource_id: agentId, metadata: meta }),

  commandSourceChanged: (ctx: AuditContext, pluginId: string, action: 'add' | 'remove', meta?: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'command.source_changed', resource_type: 'plugin', resource_id: pluginId, metadata: { action, ...meta } }),

  // Plan 25 — @file hint
  referenceScan: (ctx: AuditContext, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'reference.scan', resource_type: 'reference', metadata: meta }),

  // Plan 26 — FS tool permission
  fsPermissionSet: (ctx: AuditContext, path: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'fs.permission_set', resource_type: 'file', resource_name: path, metadata: meta }),

  fsPermissionDenied: (ctx: AuditContext, path: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'fs.permission_denied', resource_type: 'file', resource_name: path, metadata: meta }),

  // Plan 24 — connector interactive setup
  credentialSetupStarted: (ctx: AuditContext, credentialId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'credential.setup_started', resource_type: 'credential', resource_id: credentialId, metadata: meta }),

  credentialSetupStep: (ctx: AuditContext, credentialId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'credential.setup_step', resource_type: 'credential', resource_id: credentialId, metadata: meta }),

  credentialSetupCompleted: (ctx: AuditContext, credentialId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'credential.setup_completed', resource_type: 'credential', resource_id: credentialId, metadata: meta }),

  credentialSetupFailed: (ctx: AuditContext, credentialId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'credential.setup_failed', resource_type: 'credential', resource_id: credentialId, metadata: meta }),

  credentialSetupCancelled: (ctx: AuditContext, credentialId: string, meta: Record<string, unknown>) =>
    write({ ...ctx, event_type: 'credential.setup_cancelled', resource_type: 'credential', resource_id: credentialId, metadata: meta }),

  // Generic passthrough: some callers (dispatcher) assemble the entry themselves.
  write: (entry: WriteEntry) => write(entry),
}
