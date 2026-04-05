import { getAgentsByProjectId, getAgentById, loadProjectPolicyRules } from '@jiku-studio/db'
import { JikuRuntime, PluginLoader, createProviderDef } from '@jiku/core'
import type { JikuRunParams, JikuRunResult } from '@jiku/types'
import { defineAgent } from '@jiku/kit'
import { StudioStorageAdapter } from './storage.ts'
import { buildProvider, resolveAgentModel } from '../credentials/service.ts'

// Sentinel model_id — the dynamic provider resolves the model from the credential
const DYNAMIC_MODEL_ID = '__dynamic__'
const DYNAMIC_PROVIDER_ID = '__studio__'

/**
 * JikuRuntimeManager
 *
 * Manages one JikuRuntime per project (project = runtime in @jiku/core terminology).
 * Provider is a single dynamic entry that resolves the agent's credential on every
 * getModel() call — this keeps decrypted keys out of long-lived memory.
 */
export class JikuRuntimeManager {
  private runtimes = new Map<string, JikuRuntime>()
  private storages = new Map<string, StudioStorageAdapter>()

  // Per-agent resolved model cache for the current request (cleared after each run)
  private modelCache = new Map<string, ReturnType<typeof buildProvider>>()

  async wakeUp(projectId: string): Promise<void> {
    const agentRows = await getAgentsByProjectId(projectId)
    const rules = await loadProjectPolicyRules(projectId)
    const storage = new StudioStorageAdapter(projectId)
    const plugins = new PluginLoader()

    // Dynamic provider: resolves the model from modelCache at run-time
    const dynamicProviderDef = createProviderDef(DYNAMIC_PROVIDER_ID, {
      languageModel: (model_id: string) => {
        const model = this.modelCache.get(model_id)
        if (!model) throw new Error(`[studio] Model not cached for key "${model_id}". This is a bug.`)
        return model
      },
    })

    const runtime = new JikuRuntime({
      plugins,
      storage,
      rules: Array.from(rules.values()).flat(),
      providers: { [DYNAMIC_PROVIDER_ID]: dynamicProviderDef },
      default_provider: DYNAMIC_PROVIDER_ID,
    })

    await runtime.boot()

    for (const a of agentRows) {
      runtime.addAgent(defineAgent({
        meta: { id: a.id, name: a.name },
        base_prompt: a.base_prompt,
        allowed_modes: (a.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
        provider_id: DYNAMIC_PROVIDER_ID,
        model_id: DYNAMIC_MODEL_ID,
        compaction_threshold: a.compaction_threshold ?? 80,
      }))
    }

    this.runtimes.set(projectId, runtime)
    this.storages.set(projectId, storage)
  }

  async sleep(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (runtime) await runtime.stop()
    this.runtimes.delete(projectId)
    this.storages.delete(projectId)
  }

  async syncRules(projectId: string): Promise<void> {
    const runtime = await this.getRuntime(projectId)
    const rules = await loadProjectPolicyRules(projectId)
    runtime.updateRules(Array.from(rules.values()).flat())
  }

  async syncAgent(projectId: string, agentId: string): Promise<void> {
    const runtime = await this.getRuntime(projectId)
    const agent = await getAgentById(agentId)
    if (!agent) {
      runtime.removeAgent(agentId)
      return
    }
    runtime.addAgent(defineAgent({
      meta: { id: agent.id, name: agent.name },
      base_prompt: agent.base_prompt,
      allowed_modes: (agent.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
      provider_id: DYNAMIC_PROVIDER_ID,
      model_id: DYNAMIC_MODEL_ID,
      compaction_threshold: agent.compaction_threshold ?? 80,
    }))
  }

  removeAgent(projectId: string, agentId: string): void {
    this.runtimes.get(projectId)?.removeAgent(agentId)
  }

  async getRuntime(projectId: string): Promise<JikuRuntime> {
    if (!this.runtimes.has(projectId)) {
      await this.wakeUp(projectId)
    }
    return this.runtimes.get(projectId)!
  }

  /**
   * Run an agent within a project runtime.
   * Resolves the credential per-request (decrypted keys never sit in long-lived memory).
   */
  async run(projectId: string, params: JikuRunParams): Promise<JikuRunResult> {
    const runtime = await this.getRuntime(projectId)

    const modelInfo = await resolveAgentModel(params.agent_id)
    if (!modelInfo) {
      throw new Error('No model configured for this agent. Assign a credential in Agent Settings.')
    }

    // Cache the resolved model under a unique key for this request.
    // We use a unique key so concurrent requests don't collide.
    const cacheKey = `${params.agent_id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    this.modelCache.set(cacheKey, buildProvider(modelInfo))

    const result = await runtime.run({
      ...params,
      provider_id: DYNAMIC_PROVIDER_ID,
      model_id: cacheKey,
    })

    // Wrap the stream to clean up the model cache after the stream is fully consumed
    const originalStream = result.stream
    const cacheRef = this.modelCache
    const wrappedStream = new ReadableStream({
      start(controller) {
        const reader = originalStream.getReader()
        function pump(): void {
          reader.read().then(({ done, value }) => {
            if (done) {
              cacheRef.delete(cacheKey)
              controller.close()
            } else {
              controller.enqueue(value)
              pump()
            }
          }).catch((err: unknown) => {
            cacheRef.delete(cacheKey)
            controller.error(err)
          })
        }
        pump()
      },
      cancel() {
        cacheRef.delete(cacheKey)
      },
    })

    return { ...result, stream: wrappedStream as typeof result.stream }
  }

  async previewRun(projectId: string, params: {
    agent_id: string
    caller: import('@jiku/types').CallerContext
    mode: import('@jiku/types').AgentMode
    conversation_id?: string
  }): Promise<import('@jiku/types').PreviewRunResult> {
    const runtime = await this.getRuntime(projectId)
    return runtime.previewRun(params)
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.runtimes.entries()).map(([, rt]) => rt.stop()),
    )
    this.runtimes.clear()
    this.storages.clear()
  }
}

export const runtimeManager = new JikuRuntimeManager()
