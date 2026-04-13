import { getAgentById, updateAgent, createTaskConversation } from '@jiku-studio/db'
import { runTaskConversation } from './runner.ts'
import { Cron } from 'croner'

/**
 * Returns the next Date after `from` for a standard 5-field cron expression.
 * Uses `croner` (same library as cron/scheduler.ts + dream-scheduler.ts) so
 * patterns like `*\/30 * * * *` and `0 9 * * 1-5` work correctly. Previous
 * hand-rolled parser silently treated `*\/30` as NaN and fell back to
 * "every minute", causing wrong fire intervals.
 */
function getNextCronDate(expression: string, from: Date = new Date()): Date | null {
  try {
    const trimmed = expression.trim()
    // Reject 6-field (with seconds) — heartbeat policy is minute-resolution at most
    // to prevent runaway loops if someone enters "*/30 * * * * *" by mistake.
    if (trimmed.split(/\s+/).length !== 5) return null
    const cron = new Cron(trimmed)
    const next = cron.nextRun(from)
    return next ?? null
  } catch {
    return null
  }
}

/** Parse cron to milliseconds until next run */
function msUntilNext(expression: string): number {
  const next = getNextCronDate(expression)
  if (!next) return -1
  return Math.max(next.getTime() - Date.now(), 0)
}

interface ScheduledJob {
  agentId: string
  projectId: string
  timeout: ReturnType<typeof setTimeout>
}

export class HeartbeatScheduler {
  private jobs = new Map<string, ScheduledJob>()

  async scheduleAgent(agentId: string, projectId: string): Promise<void> {
    const agent = await getAgentById(agentId)
    if (!agent?.heartbeat_enabled || !agent.heartbeat_cron) return
    if (!(agent.allowed_modes ?? []).includes('task')) {
      console.warn(`[heartbeat] Not scheduling agent ${agentId}: task mode not enabled`)
      return
    }

    this.stopAgent(agentId)

    const scheduleNext = () => {
      const delayMs = msUntilNext(agent.heartbeat_cron!)
      if (delayMs < 0) {
        console.warn(`[heartbeat] Invalid cron "${agent.heartbeat_cron}" for agent ${agentId}`)
        return
      }

      const timeout = setTimeout(async () => {
        await this.triggerHeartbeat(agentId, projectId)
        // Reschedule after trigger
        const updatedAgent = await getAgentById(agentId)
        if (
          updatedAgent?.heartbeat_enabled &&
          updatedAgent.heartbeat_cron &&
          (updatedAgent.allowed_modes ?? []).includes('task')
        ) {
          scheduleNext()
        }
      }, delayMs)

      this.jobs.set(agentId, { agentId, projectId, timeout })

      const next = getNextCronDate(agent.heartbeat_cron!)
      updateAgent(agentId, { heartbeat_next_run_at: next ?? undefined })
        .catch(err => console.warn('[heartbeat] Failed to update next_run_at:', err))
    }

    scheduleNext()
  }

  async triggerHeartbeat(agentId: string, projectId: string): Promise<string> {
    const agent = await getAgentById(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)

    // Guard: heartbeat runs as a task — skip if task mode is not enabled for this agent
    const allowedModes = agent.allowed_modes ?? []
    if (!allowedModes.includes('task')) {
      console.warn(`[heartbeat] Skipping agent ${agentId}: task mode not enabled (allowed_modes=${JSON.stringify(allowedModes)})`)
      throw new Error(`Agent ${agentId} does not have task mode enabled`)
    }

    const now = new Date()
    const prompt = buildHeartbeatPrompt(agent)

    const conv = await createTaskConversation({
      agent_id: agentId,
      project_id: projectId,
      type: 'heartbeat',
      caller_id: null,
      parent_conversation_id: null,
      metadata: {
        scheduled_at: now.toISOString(),
        trigger: 'cron',
      },
    })

    // Run async, non-blocking
    runTaskConversation(projectId, conv.id, agentId, prompt, null)
      .then(() => updateAgent(agentId, { heartbeat_last_run_at: now }))
      .catch(err => console.error(`[heartbeat] Run failed for agent ${agentId}:`, err))

    return conv.id
  }

  async rescheduleAgent(agentId: string, projectId: string): Promise<void> {
    this.stopAgent(agentId)
    await this.scheduleAgent(agentId, projectId)
  }

  stopAgent(agentId: string): void {
    const job = this.jobs.get(agentId)
    if (job) {
      clearTimeout(job.timeout)
      this.jobs.delete(agentId)
    }
  }

  stopAll(): void {
    for (const job of this.jobs.values()) {
      clearTimeout(job.timeout)
    }
    this.jobs.clear()
  }
}

function buildHeartbeatPrompt(agent: { name: string; heartbeat_prompt?: string | null }): string {
  const custom = agent.heartbeat_prompt?.trim()
  if (custom) return custom

  return `You are running in heartbeat mode — a scheduled autonomous check-in for agent "${agent.name}".

Your responsibilities in this heartbeat:
- Review any pending items or goals you're aware of
- Check if there are tasks you should initiate based on your memory and project context
- Spawn tasks for any work that needs to be done

Be proactive but focused. Only take action if there's meaningful work to do.
If nothing requires attention, you may complete this heartbeat without action.

Current time: ${new Date().toISOString()}`
}

export const heartbeatScheduler = new HeartbeatScheduler()
