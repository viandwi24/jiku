import { Router } from 'express'
import {
  listProjectPluginPermissions,
  listMemberPluginPermissions,
  replaceMemberPluginPermissions,
  grantPluginPermission,
  revokePluginPermission,
  getProjectMembership,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { audit, auditContext } from '../audit/logger.ts'

const router = Router()
router.use(authMiddleware)

/** GET /api/projects/:pid/plugin-permissions — all grants in project */
router.get('/projects/:pid/plugin-permissions', requirePermission('members:read'), async (req, res) => {
  const rows = await listProjectPluginPermissions(req.params['pid'] as string)
  res.json({ grants: rows })
})

/** GET /api/projects/:pid/members/:uid/plugin-permissions */
router.get('/projects/:pid/members/:uid/plugin-permissions', requirePermission('members:read'), async (req, res) => {
  const grants = await listMemberPluginPermissions(req.params['pid'] as string, req.params['uid'] as string)
  res.json({ grants })
})

/** PUT /api/projects/:pid/members/:uid/plugin-permissions — replace-all */
router.put('/projects/:pid/members/:uid/plugin-permissions', requirePermission('members:write'), async (req, res) => {
  const pid = req.params['pid'] as string
  const uid = req.params['uid'] as string
  const { grants } = req.body as { grants: Array<{ plugin_id: string; permission: string }> }
  if (!Array.isArray(grants)) { res.status(400).json({ error: 'grants must be an array' }); return }

  const actor = res.locals['user_id'] as string
  await replaceMemberPluginPermissions(pid, uid, grants, actor)
  for (const g of grants) audit.permissionGranted({ ...auditContext(req), project_id: pid }, uid, g.plugin_id, g.permission)
  res.json({ ok: true })
})

/** POST /api/projects/:pid/plugin-permissions/grant */
router.post('/projects/:pid/plugin-permissions/grant', requirePermission('members:write'), async (req, res) => {
  const pid = req.params['pid'] as string
  const actor = res.locals['user_id'] as string
  const { user_id, plugin_id, permission } = req.body as { user_id: string; plugin_id: string; permission: string }
  if (!user_id || !plugin_id || !permission) {
    res.status(400).json({ error: 'user_id, plugin_id, permission are required' }); return
  }

  const membership = await getProjectMembership(pid, user_id)
  if (!membership) { res.status(404).json({ error: 'User is not a member of this project' }); return }

  const grant = await grantPluginPermission({
    project_id: pid,
    membership_id: membership.id,
    plugin_id,
    permission,
    granted_by: actor,
  })
  audit.permissionGranted({ ...auditContext(req), project_id: pid }, user_id, plugin_id, permission)
  res.status(201).json({ grant })
})

/** DELETE /api/projects/:pid/plugin-permissions/:id */
router.delete('/projects/:pid/plugin-permissions/:id', requirePermission('members:write'), async (req, res) => {
  const pid = req.params['pid'] as string
  const id = req.params['id'] as string

  // Look up the grant so we can audit it, then delete.
  const all = await listProjectPluginPermissions(pid)
  const target = all.find(g => g.id === id)
  if (!target) { res.status(404).json({ error: 'Grant not found' }); return }

  await revokePluginPermission(id)
  audit.permissionRevoked({ ...auditContext(req), project_id: pid }, target.user?.id ?? '', target.plugin_id, target.permission)
  res.json({ ok: true })
})

export { router as pluginPermissionsRouter }
