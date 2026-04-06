import { Router } from 'express'
import { ROLE_PRESETS } from '@jiku/types'
import {
  listProjectRoles,
  getProjectRoleById,
  createProjectRole,
  updateProjectRole,
  deleteProjectRole,
  listProjectMembers,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'

const router = Router()
router.use(authMiddleware)

/** GET /api/projects/:pid/roles */
router.get('/projects/:pid/roles', requirePermission('members:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const roles = await listProjectRoles(projectId)

  // Attach member count per role
  const members = await listProjectMembers(projectId)
  const countMap: Record<string, number> = {}
  for (const m of members) {
    if (m.role_id) countMap[m.role_id] = (countMap[m.role_id] ?? 0) + 1
  }

  res.json({ roles: roles.map(r => ({ ...r, member_count: countMap[r.id] ?? 0 })) })
})

/** POST /api/projects/:pid/roles */
router.post('/projects/:pid/roles', requirePermission('roles:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const { name, description, permissions, is_default } = req.body as {
    name: string
    description?: string
    permissions?: string[]
    is_default?: boolean
  }

  const role = await createProjectRole({
    project_id: projectId as string,
    name,
    description: description ?? null,
    permissions: permissions ?? [],
    is_default: is_default ?? false,
  })

  res.status(201).json({ role })
})

/** PATCH /api/projects/:pid/roles/:rid */
router.patch('/projects/:pid/roles/:rid', requirePermission('roles:write'), async (req, res) => {
  const { pid, rid } = req.params as { pid: string; rid: string }

  const existing = await getProjectRoleById(rid)
  if (!existing || existing.project_id !== pid) {
    res.status(404).json({ error: 'Role not found' })
    return
  }

  const { name, description, permissions, is_default } = req.body as {
    name?: string
    description?: string
    permissions?: string[]
    is_default?: boolean
  }

  const role = await updateProjectRole(rid, {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(is_default !== undefined ? { is_default } : {}),
  })

  res.json({ role })
})

/** DELETE /api/projects/:pid/roles/:rid */
router.delete('/projects/:pid/roles/:rid', requirePermission('roles:write'), async (req, res) => {
  const { pid, rid } = req.params as { pid: string; rid: string }

  const existing = await getProjectRoleById(rid)
  if (!existing || existing.project_id !== pid) {
    res.status(404).json({ error: 'Role not found' })
    return
  }

  await deleteProjectRole(rid)
  res.json({ ok: true })
})

/** GET /api/projects/:pid/roles/presets — list built-in role presets for importing */
router.get('/projects/:pid/roles/presets', requirePermission('roles:write'), (_req, res) => {
  res.json({ presets: ROLE_PRESETS })
})

export { router as aclRolesRouter }
