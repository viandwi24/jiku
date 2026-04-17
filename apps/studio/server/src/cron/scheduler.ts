import { Cron } from 'croner'
import {
  getCronTaskById,
  getEnabledCronTasks,
  updateCronTask,
  incrementRunCount,
  archiveCronTask,
  createTaskConversation,
} from '@jiku-studio/db'
import { runTaskConversation } from '../task/runner.ts'
import { composeCronRunInput, type CronContext } from './context.ts'
import { dispatchSlashCommand } from '../commands/dispatcher.ts'

type ScheduledJob =
  | { kind: 'recurring'; taskId: string; projectId: string; job: Cron }
  | { kind: 'once'; taskId: string; projectId: string; timer: ReturnType<typeof setTimeout> }

export class CronTaskScheduler {
  private jobs = new Map<string, ScheduledJob>()

  async scheduleTask(taskId: string, projectId: string): Promise<void> {
    const task = await getCronTaskById(taskId)
    if (!task || !task.enabled || task.status !== 'active') return

    const allowedModes = (task.agent?.allowed_modes ?? []) as string[]
    if (!allowedModes.includes('task')) {
      console.warn(`[cron] Not scheduling task ${taskId}: agent task mode not enabled`)
      return
    }

    this.stopTask(taskId)

    if (task.mode === 'once') {
      await this.scheduleOnce(taskId, projectId, task.run_at)
      return
    }

    // recurring
    if (!task.cron_expression) {
      console.warn(`[cron] Recurring task ${taskId} has no cron_expression — skipping`)
      return
    }

    try {
      const job = new Cron(task.cron_expression, { timezone: 'UTC', protect: true }, async () => {
        await this.triggerTask(taskId, projectId)
      })

      this.jobs.set(taskId, { kind: 'recurring', taskId, projectId, job })

      const nextRun = job.nextRun()
      if (nextRun) {
        updateCronTask(taskId, { next_run_at: nextRun })
          .catch(err => console.warn('[cron] Failed to update next_run_at:', err))
      }

      console.log(`[cron] Scheduled recurring task "${task.name}" (${taskId}) expr="${task.cron_expression}"`)
    } catch (err) {
      console.error(`[cron] Failed to schedule task ${taskId}:`, err)
    }
  }

  private async scheduleOnce(taskId: string, projectId: string, runAt: Date | null): Promise<void> {
    if (!runAt) {
      console.warn(`[cron] Once task ${taskId} has no run_at — skipping`)
      return
    }
    const delay = runAt.getTime() - Date.now()
    // Past-due tasks (server was down) fire ~immediately so the user isn't silently dropped.
    const effectiveDelay = Math.max(0, delay)
    const timer = setTimeout(() => {
      this.triggerTask(taskId, projectId).catch(err =>
        console.error(`[cron] Once task ${taskId} trigger failed:`, err)
      )
    }, effectiveDelay)

    this.jobs.set(taskId, { kind: 'once', taskId, projectId, timer })
    updateCronTask(taskId, { next_run_at: runAt })
      .catch(err => console.warn('[cron] Failed to update next_run_at:', err))

    console.log(`[cron] Scheduled once task (${taskId}) to fire at ${runAt.toISOString()} (in ${Math.round(effectiveDelay / 1000)}s)`)
  }

  async triggerTask(taskId: string, projectId: string): Promise<string> {
    const task = await getCronTaskById(taskId)
    if (!task) throw new Error(`Cron task ${taskId} not found`)

    const allowedModes = (task.agent?.allowed_modes ?? []) as string[]
    if (!allowedModes.includes('task')) {
      throw new Error(`Agent for cron task ${taskId} does not have task mode enabled`)
    }

    const now = new Date()
    const isOnce = task.mode === 'once'

    const conv = await createTaskConversation({
      agent_id: task.agent_id,
      project_id: task.project_id,
      type: 'task',
      caller_id: task.caller_id ?? null,
      parent_conversation_id: null,
      metadata: {
        cron_task_id: taskId,
        cron_task_name: task.name,
        scheduled_at: now.toISOString(),
        trigger: 'cron',
        mode: task.mode,
      },
    })

    // Plan 24 — slash-command pre-dispatch. When the stored prompt is a
    // `/slug …` invocation, resolve the SOP body BEFORE composing the cron
    // preamble so the agent sees the full command body inside the
    // `Instruction:` section. The task runner also calls the dispatcher but
    // its input would start with `[Cron Trigger]` (preamble prefix) and fail
    // the `startsWith('/')` guard — so we dispatch upstream here.
    const cmd = await dispatchSlashCommand({
      projectId: task.project_id,
      agentId: task.agent_id,
      input: task.prompt,
      surface: 'cron',
      userId: task.caller_id ?? null,
    }).catch(() => ({ matched: false, resolvedInput: undefined } as const))
    const effectivePrompt = (cmd.matched && cmd.resolvedInput) ? cmd.resolvedInput : task.prompt

    const runInput = composeCronRunInput(effectivePrompt, (task.context ?? {}) as CronContext)
    runTaskConversation(task.project_id, conv.id, task.agent_id, runInput, task.caller_id ?? null, { triggeredByCron: true, allowCreateCron: true })
      .then(async () => {
        await incrementRunCount(taskId)
        if (isOnce) {
          // Fire-and-archive: no retry (per spec) — successful run locks the task to history.
          this.stopTask(taskId)
          await archiveCronTask(taskId)
          console.log(`[cron] Once task ${taskId} fired — archived`)
          return
        }
        const updatedTask = await getCronTaskById(taskId)
        if (updatedTask?.enabled && updatedTask.status === 'active') {
          const scheduled = this.jobs.get(taskId)
          if (scheduled?.kind === 'recurring') {
            const nextRun = scheduled.job.nextRun()
            if (nextRun) {
              updateCronTask(taskId, { next_run_at: nextRun })
                .catch(err => console.warn('[cron] Failed to update next_run_at:', err))
            }
          }
        }
      })
      .catch(err => console.error(`[cron] Run failed for task ${taskId}:`, err))

    return conv.id
  }

  async rescheduleTask(taskId: string, projectId: string): Promise<void> {
    this.stopTask(taskId)
    await this.scheduleTask(taskId, projectId)
  }

  stopTask(taskId: string): void {
    const scheduled = this.jobs.get(taskId)
    if (!scheduled) return
    if (scheduled.kind === 'recurring') scheduled.job.stop()
    else clearTimeout(scheduled.timer)
    this.jobs.delete(taskId)
  }

  stopAll(): void {
    for (const scheduled of this.jobs.values()) {
      if (scheduled.kind === 'recurring') scheduled.job.stop()
      else clearTimeout(scheduled.timer)
    }
    this.jobs.clear()
  }

  async loadAndScheduleProject(projectId: string): Promise<void> {
    const tasks = await getEnabledCronTasks(projectId)
    for (const task of tasks) {
      await this.scheduleTask(task.id, projectId)
    }
    if (tasks.length > 0) {
      console.log(`[cron] Scheduled ${tasks.length} cron task(s) for project ${projectId}`)
    }
  }
}

export const cronTaskScheduler = new CronTaskScheduler()
