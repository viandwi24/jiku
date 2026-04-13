import { Router } from 'express'
import {
  getCronTasksByProject,
  getCronTaskById,
  createCronTask,
  updateCronTask,
  deleteCronTask,
  archiveCronTask,
  restoreCronTask,
  type CronTaskStatus,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, loadPerms } from '../middleware/permission.ts'
import { cronTaskScheduler } from '../cron/scheduler.ts'

const router = Router()
router.use(authMiddleware)

/** GET /projects/:pid/cron-tasks — list cron tasks for a project */
router.get('/projects/:pid/cron-tasks', requirePermission('cron_tasks:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const userId = res.locals['user_id'] as string
  const perms = await loadPerms(req, res)
  const isSuperadmin = perms?.resolved.isSuperadmin ?? false
  // Users with cron_tasks:write (admin/manager-tier) see everyone's tasks.
  // Users with only cron_tasks:read see only their own — previous default was everyone-own-only
  // which hid the list from admins. Superadmins always see all.
  const canSeeAll = isSuperadmin || (perms?.resolved.permissions?.includes('cron_tasks:write') ?? false)

  const includeArchived = req.query['include_archived'] === '1' || req.query['include_archived'] === 'true'
  const onlyArchived = req.query['status'] === 'archived'
  const statuses: CronTaskStatus[] = onlyArchived
    ? ['archived']
    : includeArchived
      ? ['active', 'archived']
      : ['active']

  const tasks = await getCronTasksByProject(projectId, {
    statuses,
    ...(canSeeAll ? {} : { callerIdFilter: userId }),
  })

  res.json({ cron_tasks: tasks })
})

/** POST /projects/:pid/cron-tasks — create a new cron task */
router.post('/projects/:pid/cron-tasks', requirePermission('cron_tasks:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const userId = res.locals['user_id'] as string
  const perms = await loadPerms(req, res)
  const isSuperadmin = perms?.resolved.isSuperadmin ?? false
  const callerRole: string | null = null

  const body = (req.body ?? {}) as {
    agent_id?: string
    name?: string
    description?: string
    mode?: 'recurring' | 'once'
    cron_expression?: string
    run_at?: string
    prompt?: string
    enabled?: boolean
  }

  const mode: 'recurring' | 'once' = body.mode === 'once' ? 'once' : 'recurring'

  if (!body.agent_id) { res.status(400).json({ error: 'agent_id is required' }); return }
  if (!body.name?.trim()) { res.status(400).json({ error: 'name is required' }); return }
  if (!body.prompt?.trim()) { res.status(400).json({ error: 'prompt is required' }); return }

  let runAt: Date | null = null
  if (mode === 'recurring') {
    if (!body.cron_expression?.trim()) { res.status(400).json({ error: 'cron_expression is required for recurring mode' }); return }
  } else {
    if (!body.run_at) { res.status(400).json({ error: 'run_at is required for once mode' }); return }
    const d = new Date(body.run_at)
    if (Number.isNaN(d.getTime())) { res.status(400).json({ error: 'run_at is not a valid ISO datetime' }); return }
    runAt = d
  }

  const task = await createCronTask({
    project_id: projectId,
    agent_id: body.agent_id,
    name: body.name.trim(),
    description: body.description?.trim() ?? null,
    mode,
    cron_expression: mode === 'recurring' ? (body.cron_expression?.trim() ?? null) : null,
    run_at: runAt,
    prompt: body.prompt.trim(),
    enabled: body.enabled ?? true,
    status: 'active',
    caller_id: userId,
    caller_role: callerRole,
    caller_is_superadmin: isSuperadmin,
    metadata: {},
  })

  if (task.enabled) {
    cronTaskScheduler.scheduleTask(task.id, projectId).catch(err =>
      console.warn('[cron] Failed to schedule new task:', err)
    )
  }

  res.status(201).json({ cron_task: task })
})

/** GET /projects/:pid/cron-tasks/:id — get a single cron task */
router.get('/projects/:pid/cron-tasks/:id', requirePermission('cron_tasks:read'), async (req, res) => {
  const task = await getCronTaskById(req.params['id']!)
  if (!task || task.project_id !== req.params['pid']!) {
    res.status(404).json({ error: 'Cron task not found' })
    return
  }
  res.json({ cron_task: task })
})

/** PATCH /projects/:pid/cron-tasks/:id — update a cron task */
router.patch('/projects/:pid/cron-tasks/:id', requirePermission('cron_tasks:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const taskId = req.params['id']!
  const perms = await loadPerms(req, res)
  const isSuperadmin = perms?.resolved.isSuperadmin ?? false

  const existing = await getCronTaskById(taskId)
  if (!existing || existing.project_id !== projectId) {
    res.status(404).json({ error: 'Cron task not found' })
    return
  }

  if (existing.caller_is_superadmin && !isSuperadmin) {
    res.status(403).json({ error: 'Only a superadmin can modify a superadmin-created cron task' })
    return
  }

  const body = (req.body ?? {}) as {
    name?: string
    description?: string
    mode?: 'recurring' | 'once'
    cron_expression?: string | null
    run_at?: string | null
    prompt?: string
    enabled?: boolean
    agent_id?: string
  }

  const updates: Parameters<typeof updateCronTask>[1] = {}
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.description !== undefined) updates.description = body.description?.trim() ?? null
  if (body.mode !== undefined) updates.mode = body.mode
  if (body.cron_expression !== undefined) {
    updates.cron_expression = body.cron_expression === null ? null : body.cron_expression.trim()
  }
  if (body.run_at !== undefined) {
    if (body.run_at === null) {
      updates.run_at = null
    } else {
      const d = new Date(body.run_at)
      if (Number.isNaN(d.getTime())) { res.status(400).json({ error: 'run_at is not a valid ISO datetime' }); return }
      updates.run_at = d
    }
  }
  if (body.prompt !== undefined) updates.prompt = body.prompt.trim()
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.agent_id !== undefined) updates.agent_id = body.agent_id

  const task = await updateCronTask(taskId, updates)

  if (task.enabled) {
    cronTaskScheduler.rescheduleTask(task.id, projectId).catch(err =>
      console.warn('[cron] Failed to reschedule task:', err)
    )
  } else {
    cronTaskScheduler.stopTask(task.id)
  }

  res.json({ cron_task: task })
})

/** DELETE /projects/:pid/cron-tasks/:id — delete a cron task */
router.delete('/projects/:pid/cron-tasks/:id', requirePermission('cron_tasks:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const taskId = req.params['id']!
  const perms = await loadPerms(req, res)
  const isSuperadmin = perms?.resolved.isSuperadmin ?? false

  const existing = await getCronTaskById(taskId)
  if (!existing || existing.project_id !== projectId) {
    res.status(404).json({ error: 'Cron task not found' })
    return
  }

  if (existing.caller_is_superadmin && !isSuperadmin) {
    res.status(403).json({ error: 'Only a superadmin can delete a superadmin-created cron task' })
    return
  }

  cronTaskScheduler.stopTask(taskId)
  await deleteCronTask(taskId)

  res.json({ ok: true })
})

/** POST /projects/:pid/cron-tasks/:id/archive — archive a cron task (soft, reversible) */
router.post('/projects/:pid/cron-tasks/:id/archive', requirePermission('cron_tasks:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const taskId = req.params['id']!
  const perms = await loadPerms(req, res)
  const isSuperadmin = perms?.resolved.isSuperadmin ?? false

  const existing = await getCronTaskById(taskId)
  if (!existing || existing.project_id !== projectId) {
    res.status(404).json({ error: 'Cron task not found' })
    return
  }
  if (existing.caller_is_superadmin && !isSuperadmin) {
    res.status(403).json({ error: 'Only a superadmin can modify a superadmin-created cron task' })
    return
  }

  cronTaskScheduler.stopTask(taskId)
  const task = await archiveCronTask(taskId)
  res.json({ cron_task: task })
})

/** POST /projects/:pid/cron-tasks/:id/restore — restore an archived cron task */
router.post('/projects/:pid/cron-tasks/:id/restore', requirePermission('cron_tasks:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const taskId = req.params['id']!
  const perms = await loadPerms(req, res)
  const isSuperadmin = perms?.resolved.isSuperadmin ?? false

  const existing = await getCronTaskById(taskId)
  if (!existing || existing.project_id !== projectId) {
    res.status(404).json({ error: 'Cron task not found' })
    return
  }
  if (existing.caller_is_superadmin && !isSuperadmin) {
    res.status(403).json({ error: 'Only a superadmin can modify a superadmin-created cron task' })
    return
  }

  const task = await restoreCronTask(taskId)
  if (task.enabled) {
    cronTaskScheduler.scheduleTask(task.id, projectId).catch(err =>
      console.warn('[cron] Failed to reschedule restored task:', err)
    )
  }
  res.json({ cron_task: task })
})

/** POST /projects/:pid/cron-tasks/:id/trigger — manually trigger a cron task */
router.post('/projects/:pid/cron-tasks/:id/trigger', requirePermission('cron_tasks:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const taskId = req.params['id']!

  const existing = await getCronTaskById(taskId)
  if (!existing || existing.project_id !== projectId) {
    res.status(404).json({ error: 'Cron task not found' })
    return
  }

  const conversationId = await cronTaskScheduler.triggerTask(taskId, projectId)
  res.json({ ok: true, conversation_id: conversationId })
})

export { router as cronTasksRouter }
