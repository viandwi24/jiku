import { and, eq, sql, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import { cron_tasks } from '../schema/index.ts'
import type { NewCronTask } from '../schema/index.ts'

export type CronTaskStatus = 'active' | 'archived'
export type CronTaskMode = 'recurring' | 'once'

export async function createCronTask(data: Omit<NewCronTask, 'id' | 'created_at' | 'updated_at' | 'run_count' | 'last_run_at' | 'next_run_at'>) {
  const [task] = await db.insert(cron_tasks).values(data).returning()
  return task!
}

export async function getCronTaskById(id: string) {
  return db.query.cron_tasks.findFirst({
    where: eq(cron_tasks.id, id),
    with: {
      agent: true,
      caller: true,
    },
  })
}

interface ListOpts {
  callerIdFilter?: string
  /** Status filter. Default: ['active']. Pass ['active','archived'] for everything. */
  statuses?: CronTaskStatus[]
}

export async function getCronTasksByProject(projectId: string, opts?: ListOpts) {
  const statuses = opts?.statuses ?? ['active']
  const conds = [
    eq(cron_tasks.project_id, projectId),
    inArray(cron_tasks.status, statuses),
  ]
  if (opts?.callerIdFilter) conds.push(eq(cron_tasks.caller_id, opts.callerIdFilter))
  return db.query.cron_tasks.findMany({
    where: and(...conds),
    with: {
      agent: true,
      caller: true,
    },
    orderBy: (t, { desc }) => [desc(t.created_at)],
  })
}

export async function getCronTasksByAgent(agentId: string, opts?: { statuses?: CronTaskStatus[] }) {
  const statuses = opts?.statuses ?? ['active']
  return db.query.cron_tasks.findMany({
    where: and(
      eq(cron_tasks.agent_id, agentId),
      inArray(cron_tasks.status, statuses),
    ),
    with: {
      agent: true,
      caller: true,
    },
    orderBy: (t, { desc }) => [desc(t.created_at)],
  })
}

export async function updateCronTask(
  id: string,
  updates: Partial<Omit<NewCronTask, 'id' | 'created_at'>>,
) {
  const [task] = await db
    .update(cron_tasks)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(cron_tasks.id, id))
    .returning()
  return task!
}

export async function archiveCronTask(id: string) {
  const [task] = await db
    .update(cron_tasks)
    .set({ status: 'archived', enabled: false, next_run_at: null, updated_at: new Date() })
    .where(eq(cron_tasks.id, id))
    .returning()
  return task!
}

export async function restoreCronTask(id: string) {
  const [task] = await db
    .update(cron_tasks)
    .set({ status: 'active', updated_at: new Date() })
    .where(eq(cron_tasks.id, id))
    .returning()
  return task!
}

export async function deleteCronTask(id: string) {
  await db.delete(cron_tasks).where(eq(cron_tasks.id, id))
}

export async function incrementRunCount(id: string) {
  const now = new Date()
  const [task] = await db
    .update(cron_tasks)
    .set({
      run_count: sql`${cron_tasks.run_count} + 1`,
      last_run_at: now,
      updated_at: now,
    })
    .where(eq(cron_tasks.id, id))
    .returning()
  return task!
}

/** Returns active, enabled tasks (used by scheduler on project load). */
export async function getEnabledCronTasks(projectId: string) {
  return db.query.cron_tasks.findMany({
    where: and(
      eq(cron_tasks.project_id, projectId),
      eq(cron_tasks.enabled, true),
      eq(cron_tasks.status, 'active'),
    ),
    with: {
      agent: true,
    },
  })
}
