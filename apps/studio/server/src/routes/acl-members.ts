import { Router } from 'express'
import {
  listProjectMembers,
  getProjectMembership,
  updateProjectMembership,
  removeProjectMembership,
  resolveProjectPermissions,
  logSuperadminTransfer,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, requireSuperadmin } from '../middleware/permission.ts'
import { audit, auditContext } from '../audit/logger.ts'

const router = Router()
router.use(authMiddleware)

/** GET /api/projects/:pid/members */
router.get('/projects/:pid/members', requirePermission('members:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const members = await listProjectMembers(projectId)
  res.json({ members })
})

/** GET /api/projects/:pid/members/me/permissions — resolved permissions for current user */
router.get('/projects/:pid/members/me/permissions', async (req, res) => {
  const projectId = req.params['pid'] as string
  const userId = res.locals['user_id'] as string
  const resolved = await resolveProjectPermissions(projectId, userId)
  res.json(resolved)
})

/** PATCH /api/projects/:pid/members/:uid/role — assign role */
router.patch('/projects/:pid/members/:uid/role', requirePermission('members:write'), async (req, res) => {
  const { pid, uid } = req.params as { pid: string; uid: string }
  const { role_id } = req.body as { role_id: string | null }

  const membership = await getProjectMembership(pid, uid)
  if (!membership) { res.status(404).json({ error: 'Member not found' }); return }

  const updated = await updateProjectMembership(pid, uid, { role_id: role_id ?? undefined })
  audit.memberRoleChanged({ ...auditContext(req), project_id: pid }, uid, role_id ?? null)
  res.json({ membership: updated })
})

/** PATCH /api/projects/:pid/members/:uid/superadmin — grant/revoke superadmin */
router.patch('/projects/:pid/members/:uid/superadmin', requireSuperadmin(), async (req, res) => {
  const { pid, uid } = req.params as { pid: string; uid: string }
  const currentUserId = res.locals['user_id'] as string
  const { grant } = req.body as { grant: boolean }

  const membership = await getProjectMembership(pid, uid)
  if (!membership) { res.status(404).json({ error: 'Member not found' }); return }

  const updated = await updateProjectMembership(pid, uid, { is_superadmin: grant })

  if (grant) {
    await logSuperadminTransfer(pid, currentUserId, uid)
  }

  res.json({ membership: updated })
})

/** PATCH /api/projects/:pid/members/:uid/agent-restrictions */
router.patch('/projects/:pid/members/:uid/agent-restrictions', requirePermission('members:write'), async (req, res) => {
  const { pid, uid } = req.params as { pid: string; uid: string }
  const { agent_restrictions } = req.body as { agent_restrictions: Record<string, boolean> }

  const membership = await getProjectMembership(pid, uid)
  if (!membership) { res.status(404).json({ error: 'Member not found' }); return }

  const updated = await updateProjectMembership(pid, uid, { agent_restrictions })
  res.json({ membership: updated })
})

/** PATCH /api/projects/:pid/members/:uid/tool-restrictions */
router.patch('/projects/:pid/members/:uid/tool-restrictions', requirePermission('members:write'), async (req, res) => {
  const { pid, uid } = req.params as { pid: string; uid: string }
  const { tool_restrictions } = req.body as { tool_restrictions: Record<string, Record<string, boolean>> }

  const membership = await getProjectMembership(pid, uid)
  if (!membership) { res.status(404).json({ error: 'Member not found' }); return }

  const updated = await updateProjectMembership(pid, uid, { tool_restrictions })
  res.json({ membership: updated })
})

/** DELETE /api/projects/:pid/members/:uid */
router.delete('/projects/:pid/members/:uid', requirePermission('members:write'), async (req, res) => {
  const { pid, uid } = req.params as { pid: string; uid: string }

  const membership = await getProjectMembership(pid, uid)
  if (!membership) { res.status(404).json({ error: 'Member not found' }); return }

  // Cannot remove the last superadmin
  if (membership.is_superadmin) {
    const allMembers = await listProjectMembers(pid)
    const superadminCount = allMembers.filter(m => m.is_superadmin).length
    if (superadminCount <= 1) {
      res.status(400).json({ error: 'Cannot remove the last superadmin' })
      return
    }
  }

  await removeProjectMembership(pid, uid)
  audit.memberRemove({ ...auditContext(req), project_id: pid }, uid)
  res.json({ ok: true })
})

export { router as aclMembersRouter }
