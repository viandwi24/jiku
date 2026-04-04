import { getAgentsByProjectId, getAgentById, loadProjectPolicyRules } from '@jiku-studio/db'
import type { PolicyRule } from '@jiku/types'
import { StudioStorageAdapter } from './storage.ts'

export interface RuntimeAgent {
  id: string
  name: string
  base_prompt: string
  allowed_modes: string[]
  provider_id: string
  model_id: string
}

export interface ProjectRuntime {
  projectId: string
  agents: Map<string, RuntimeAgent>
  rules: Map<string, PolicyRule[]>  // agentId → PolicyRule[]
  storage: StudioStorageAdapter
}

export class JikuRuntimeManager {
  private runtimes = new Map<string, ProjectRuntime>()

  // Boot a project runtime and load all current policy rules
  async wakeUp(projectId: string): Promise<void> {
    const agentRows = await getAgentsByProjectId(projectId)
    const agentMap = new Map<string, RuntimeAgent>()

    for (const a of agentRows) {
      agentMap.set(a.id, {
        id: a.id,
        name: a.name,
        base_prompt: a.base_prompt,
        allowed_modes: a.allowed_modes,
        provider_id: a.provider_id,
        model_id: a.model_id,
      })
    }

    const rules = await loadProjectPolicyRules(projectId)

    this.runtimes.set(projectId, {
      projectId,
      agents: agentMap,
      rules,
      storage: new StudioStorageAdapter(projectId),
    })
  }

  // Remove a project runtime from memory
  sleep(projectId: string): void {
    this.runtimes.delete(projectId)
  }

  // Reload policy rules for a project (called after policy changes)
  async syncRules(projectId: string): Promise<void> {
    const runtime = await this.getRuntime(projectId)
    const rules = await loadProjectPolicyRules(projectId)
    runtime.rules = rules
  }

  // Reload a single agent's definition (called after agent create/update)
  async syncAgent(projectId: string, agentId: string): Promise<void> {
    const runtime = await this.getRuntime(projectId)
    const agent = await getAgentById(agentId)
    if (!agent) {
      runtime.agents.delete(agentId)
      return
    }
    runtime.agents.set(agentId, {
      id: agent.id,
      name: agent.name,
      base_prompt: agent.base_prompt,
      allowed_modes: agent.allowed_modes,
      provider_id: agent.provider_id,
      model_id: agent.model_id,
    })
  }

  removeAgent(projectId: string, agentId: string): void {
    this.runtimes.get(projectId)?.agents.delete(agentId)
    this.runtimes.get(projectId)?.rules.delete(agentId)
  }

  async getRuntime(projectId: string): Promise<ProjectRuntime> {
    if (!this.runtimes.has(projectId)) {
      await this.wakeUp(projectId)
    }
    return this.runtimes.get(projectId)!
  }

  async stopAll(): Promise<void> {
    this.runtimes.clear()
  }
}

export const runtimeManager = new JikuRuntimeManager()
