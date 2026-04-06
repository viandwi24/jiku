import type { Request, Response, NextFunction } from 'express'
import type { Permission } from '@jiku/types'
import { resolveProjectPermissions, getAgentById } from '@jiku-studio/db'

/**
 * Resolve projectId from either:
 * - req.params.pid  (project-level routes)
 * - req.params.aid  (agent-level routes — looks up agent → project_id)
 * - req.params.cid  (conversation-level routes — caller must set res.locals.project_id upstream)
 * - res.locals.project_id (set explicitly)
 */
async function resolveProjectId(req: Request, res: Response): Promise<string | null> {
  if (req.params['pid']) return req.params['pid'] as string
  if (res.locals['project_id']) return res.locals['project_id'] as string
  if (req.params['aid']) {
    const agent = await getAgentById(req.params['aid'] as string)
    if (agent) {
      res.locals['project_id'] = agent.project_id
      return agent.project_id
    }
  }
  return null
}

type ResolvedPerms = Awaited<ReturnType<typeof resolveProjectPermissions>>

export async function loadPerms(req: Request, res: Response): Promise<{ projectId: string; resolved: ResolvedPerms } | null> {
  // Return cached if already loaded
  if (res.locals['resolved_permissions'] && res.locals['project_id']) {
    return { projectId: res.locals['project_id'] as string, resolved: res.locals['resolved_permissions'] as ResolvedPerms }
  }

  const projectId = await resolveProjectId(req, res)
  if (!projectId) return null

  const userId = res.locals['user_id'] as string
  const resolved = await resolveProjectPermissions(projectId, userId)
  res.locals['resolved_permissions'] = resolved
  res.locals['project_id'] = projectId
  return { projectId, resolved }
}

/** Require the caller to have at least one of the given permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }

    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member of this project' }); return }
    if (!resolved.isSuperadmin && !permissions.some(p => resolved.permissions.includes(p))) {
      res.status(403).json({ error: `Missing permission: requires one of [${permissions.join(', ')}]` }); return
    }
    next()
  }
}

/** Require the caller to have a specific permission in the given project. */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }

    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member of this project' }); return }
    if (!resolved.isSuperadmin && !resolved.permissions.includes(permission)) {
      res.status(403).json({ error: `Missing permission: ${permission}` }); return
    }
    next()
  }
}

/** Require the caller to be a superadmin in the given project. */
export function requireSuperadmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }

    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member of this project' }); return }
    if (!resolved.isSuperadmin) { res.status(403).json({ error: 'Superadmin required' }); return }
    next()
  }
}

/** Require the caller to be a member of the given project (any role). */
export function requireProjectMembership() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }

    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member of this project' }); return }
    next()
  }
}
