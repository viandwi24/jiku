import { Cron } from 'croner'
import {
  getCronTaskById,
  getEnabledCronTasks,
  updateCronTask,
  incrementRunCount,
  createTaskConversation,
} from '@jiku-studio/db'
import { runTaskConversation } from '../task/runner.ts'

interface ScheduledCronJob {
  taskId: string
  projectId: string
  job: Cron
}

export class CronTaskScheduler {
  private jobs = new Map<string, ScheduledCronJob>()

  async scheduleTask(taskId: string, projectId: string): Promise<void> {
    const task = await getCronTaskById(taskId)
    if (!task || !task.enabled) return

    // Verify agent supports task mode
    const allowedModes = (task.agent?.allowed_modes ?? []) as string[]
    if (!allowedModes.includes('task')) {
      console.warn(`[cron] Not scheduling task ${taskId}: agent task mode not enabled`)
      return
    }

    this.stopTask(taskId)

    try {
      const job = new Cron(task.cron_expression, { timezone: 'UTC', protect: true }, async () => {
        await this.triggerTask(taskId, projectId)
      })

      this.jobs.set(taskId, { taskId, projectId, job })

      const nextRun = job.nextRun()
      if (nextRun) {
        updateCronTask(taskId, { next_run_at: nextRun })
          .catch(err => console.warn('[cron] Failed to update next_run_at:', err))
      }

      console.log(`[cron] Scheduled task "${task.name}" (${taskId}) with expression "${task.cron_expression}"`)
    } catch (err) {
      console.error(`[cron] Failed to schedule task ${taskId}:`, err)
    }
  }

  async triggerTask(taskId: string, projectId: string): Promise<string> {
    const task = await getCronTaskById(taskId)
    if (!task) throw new Error(`Cron task ${taskId} not found`)

    const allowedModes = (task.agent?.allowed_modes ?? []) as string[]
    if (!allowedModes.includes('task')) {
      throw new Error(`Agent for cron task ${taskId} does not have task mode enabled`)
    }

    const now = new Date()

    const conv = await createTaskConversation({
      agent_id: task.agent_id,
      project_id: task.project_id,
      type: 'cron',
      caller_id: task.caller_id ?? null,
      parent_conversation_id: null,
      metadata: {
        cron_task_id: taskId,
        cron_task_name: task.name,
        scheduled_at: now.toISOString(),
        trigger: 'cron',
      },
    })

    // Run async, non-blocking
    runTaskConversation(task.project_id, conv.id, task.agent_id, task.prompt, task.caller_id ?? null)
      .then(async () => {
        await incrementRunCount(taskId)
        const updatedTask = await getCronTaskById(taskId)
        if (updatedTask?.enabled) {
          const job = this.jobs.get(taskId)
          if (job) {
            const nextRun = job.job.nextRun()
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
    if (scheduled) {
      scheduled.job.stop()
      this.jobs.delete(taskId)
    }
  }

  stopAll(): void {
    for (const scheduled of this.jobs.values()) {
      scheduled.job.stop()
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
