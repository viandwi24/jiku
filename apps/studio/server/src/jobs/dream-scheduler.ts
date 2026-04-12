import { Cron } from 'croner'
import { getAllProjects } from '@jiku-studio/db'
import type { DreamingConfig, ProjectMemoryConfig } from '@jiku/types'
import { enqueue } from './enqueue.ts'

/**
 * Plan 19 — Dreaming scheduler.
 *
 * Loads per-project dreaming config at boot and schedules cron jobs that
 * fire-and-forget enqueue a `memory.dream` job at each tick. The worker picks
 * it up asynchronously — the cron callback never blocks or awaits handler work.
 */

interface ScheduledDream {
  cron: Cron
  projectId: string
  phase: 'light' | 'deep' | 'rem'
}

class DreamScheduler {
  private jobs = new Map<string, ScheduledDream[]>() // projectId → jobs

  async bootstrap(): Promise<void> {
    const projects = await getAllProjects()
    for (const p of projects) {
      try { await this.scheduleProject(p.id) } catch (err) {
        console.warn(`[dream-scheduler] failed to schedule project ${p.id}:`, err)
      }
    }
    const total = Array.from(this.jobs.values()).reduce((n, arr) => n + arr.length, 0)
    console.log(`[dream-scheduler] bootstrapped ${total} cron jobs across ${projects.length} projects`)
  }

  async scheduleProject(projectId: string): Promise<void> {
    this.stopProject(projectId)

    const { getProjectById } = await import('@jiku-studio/db')
    const project = await getProjectById(projectId)
    if (!project) return

    const memConfig = (project.memory_config ?? {}) as Partial<ProjectMemoryConfig>
    const dreaming = memConfig.dreaming
    if (!dreaming?.enabled) return

    const scheduled: ScheduledDream[] = []
    const phases: Array<{ name: 'light' | 'deep' | 'rem'; cfg: DreamingConfig['light'] }> = [
      { name: 'light', cfg: dreaming.light },
      { name: 'deep', cfg: dreaming.deep },
      { name: 'rem', cfg: dreaming.rem },
    ]

    for (const { name, cfg } of phases) {
      if (!cfg.enabled || !cfg.cron) continue
      try {
        const cron = new Cron(cfg.cron, { timezone: 'UTC', protect: true }, () => {
          // fire-and-forget: enqueue only, worker runs the handler off the cron thread.
          void enqueue({
            type: 'memory.dream',
            projectId,
            payload: { project_id: projectId, phase: name },
            // no idempotency_key — different ticks should produce distinct jobs,
            // but we rely on `protect: true` to skip overlap from the prior tick.
          })
        })
        scheduled.push({ cron, projectId, phase: name })
      } catch (err) {
        console.warn(`[dream-scheduler] invalid cron "${cfg.cron}" for project ${projectId} phase ${name}:`, err)
      }
    }

    if (scheduled.length > 0) this.jobs.set(projectId, scheduled)
  }

  stopProject(projectId: string): void {
    const existing = this.jobs.get(projectId)
    if (!existing) return
    for (const s of existing) s.cron.stop()
    this.jobs.delete(projectId)
  }

  async reschedule(projectId: string): Promise<void> {
    await this.scheduleProject(projectId)
  }

  stopAll(): void {
    for (const [, arr] of this.jobs) for (const s of arr) s.cron.stop()
    this.jobs.clear()
  }
}

export const dreamScheduler = new DreamScheduler()

/** Manual trigger for "Run now" buttons in the UI. */
export function triggerDreamNow(projectId: string, phase: 'light' | 'deep' | 'rem'): Promise<void> {
  return enqueue({
    type: 'memory.dream',
    projectId,
    payload: { project_id: projectId, phase },
  })
}
