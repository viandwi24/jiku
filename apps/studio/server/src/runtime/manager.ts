import { getAgentsByProjectId, getAgentById, loadProjectPolicyRules, getEnabledProjectPlugins, getProjectById, getConnectors, deleteConnector } from '@jiku-studio/db'
import { JikuRuntime, PluginLoader, createProviderDef, DEFAULT_PROJECT_MEMORY_CONFIG, resolveMemoryConfig } from '@jiku/core'
import type { JikuRunParams, JikuRunResult, AgentMemoryConfig } from '@jiku/types'
import { defineAgent } from '@jiku/kit'
import { StudioStorageAdapter } from './storage.ts'
import { buildProvider, resolveAgentModel } from '../credentials/service.ts'
import { buildMemoryTools } from '../memory/tools.ts'
import { ensurePersonaSeeded } from '../memory/persona.ts'
import { buildConnectorTools } from '../connectors/tools.ts'
import { connectorRegistry } from '../connectors/registry.ts'
import { heartbeatScheduler } from '../task/heartbeat.ts'
import { buildRunTaskTool } from '../task/tools.ts'

// Sentinel model_id — the dynamic provider resolves the model from the credential
const DYNAMIC_MODEL_ID = '__dynamic__'
const DYNAMIC_PROVIDER_ID = '__studio__'

/**
 * JikuRuntimeManager
 *
 * Manages one JikuRuntime per project (project = runtime in @jiku/core terminology).
 * Provider is a single dynamic entry that resolves the agent's credential on every
 * getModel() call — this keeps decrypted keys out of long-lived memory.
 *
 * A single shared PluginLoader instance is used across all projects.
 * Each project gets its own enabled plugin set via setProjectEnabledPlugins().
 */
export class JikuRuntimeManager {
  private runtimes = new Map<string, JikuRuntime>()
  private storages = new Map<string, StudioStorageAdapter>()
  private _pluginLoader: PluginLoader | null = null

  // Per-agent resolved model cache for the current request (cleared after each run)
  private modelCache = new Map<string, ReturnType<typeof buildProvider>>()

  /** Set the shared plugin loader (called from index.ts after boot) */
  setPluginLoader(loader: PluginLoader): void {
    this._pluginLoader = loader
  }

  /** Get the shared plugin loader */
  getPluginLoader(): PluginLoader | null {
    return this._pluginLoader
  }

  async wakeUp(projectId: string): Promise<void> {
    const [agentRows, rules, projectRow] = await Promise.all([
      getAgentsByProjectId(projectId),
      loadProjectPolicyRules(projectId),
      getProjectById(projectId),
    ])
    const storage = new StudioStorageAdapter(projectId)

    // Resolve project-level memory config (fallback to platform defaults)
    const projectMemoryConfig = (projectRow?.memory_config as import('@jiku/types').ProjectMemoryConfig | null)
      ?? DEFAULT_PROJECT_MEMORY_CONFIG

    // Use the shared plugin loader if available, otherwise create an empty one
    const pluginLoader = this._pluginLoader ?? new PluginLoader()

    // Load enabled project plugins from DB and configure the loader.
    // setProjectEnabledPlugins populates the enabled set — activatePlugin only triggers lifecycle hooks.
    const enabledRows = await getEnabledProjectPlugins(projectId)
    const enabledPluginIds = enabledRows.map(r => r.plugin_id)
    pluginLoader.setProjectEnabledPlugins(projectId, enabledPluginIds)

    // Trigger onProjectPluginActivated lifecycle for each enabled plugin (no Set mutation — already done above)
    for (const row of enabledRows) {
      const plugin = pluginLoader.getAllPlugins().find(p => p.meta.id === row.plugin_id)
      if (!plugin?.onProjectPluginActivated) continue
      try {
        await pluginLoader.activatePlugin(projectId, row.plugin_id, row.config ?? {}, { updateSet: false })
      } catch (err) {
        console.warn(`[jiku] Failed to activate plugin "${row.plugin_id}" for project "${projectId}":`, err)
      }
    }

    // Dynamic provider: resolves the model from modelCache at run-time
    const dynamicProviderDef = createProviderDef(DYNAMIC_PROVIDER_ID, {
      languageModel: (model_id: string) => {
        const model = this.modelCache.get(model_id)
        if (!model) throw new Error(`[studio] Model not cached for key "${model_id}". This is a bug.`)
        return model
      },
    })

    const runtime = new JikuRuntime({
      plugins: pluginLoader,
      storage,
      rules: Array.from(rules.values()).flat(),
      providers: { [DYNAMIC_PROVIDER_ID]: dynamicProviderDef },
      default_provider: DYNAMIC_PROVIDER_ID,
      runtime_id: projectId,
    })

    await runtime.boot()

    // Build connector tools if project has active connectors
    const connectorRows = await getConnectors(projectId)
    const connectorTools = connectorRows.length > 0 ? buildConnectorTools(projectId) : []

    for (const a of agentRows) {
      // Resolve per-agent memory config (merge project defaults + agent override)
      const agentMemoryConfig = resolveMemoryConfig(
        projectMemoryConfig,
        (a.memory_config as AgentMemoryConfig | null) ?? null,
      )

      // Build memory tools scoped to this agent's resolved config
      const memoryTools = buildMemoryTools(agentMemoryConfig, storage, projectId)

      // run_task built-in tool — always active
      const runTaskTool = buildRunTaskTool(projectId, a.id, () => ({
        user_id: 'system', roles: [], permissions: [], user_data: {},
      }), () => undefined)

      runtime.addAgent(
        defineAgent({
          meta: { id: a.id, name: a.name },
          base_prompt: a.base_prompt,
          allowed_modes: (a.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
          provider_id: DYNAMIC_PROVIDER_ID,
          model_id: DYNAMIC_MODEL_ID,
          compaction_threshold: a.compaction_threshold ?? 80,
          built_in_tools: [...memoryTools, ...connectorTools, runTaskTool],
        }),
        agentMemoryConfig,
        (a.persona_seed ?? null) as import('@jiku/types').PersonaSeed | null,
        (a as Record<string, unknown>).persona_prompt as string | null ?? null,
      )

      // Schedule heartbeat if enabled
      if (a.heartbeat_enabled && a.heartbeat_cron) {
        heartbeatScheduler.scheduleAgent(a.id, projectId).catch(err =>
          console.warn(`[heartbeat] Failed to schedule agent ${a.id}:`, err)
        )
      }
    }

    this.runtimes.set(projectId, runtime)
    this.storages.set(projectId, storage)

    // Cleanup + auto-activate connectors
    const { activateConnector } = await import('../connectors/activation.ts')
    for (const connector of connectorRows) {
      // Plugin not in registry at all → connector is orphaned, delete it
      if (!connectorRegistry.get(connector.plugin_id)) {
        console.warn(`[wakeUp] connector plugin "${connector.plugin_id}" not found — deleting orphaned connector ${connector.id}`)
        await deleteConnector(connector.id).catch(err =>
          console.warn(`[wakeUp] failed to delete orphaned connector ${connector.id}:`, err)
        )
        continue
      }
      // Plugin exists but connector was active → re-activate (may error, that's ok)
      if (connector.status === 'active' && connector.credential_id) {
        activateConnector(connector.id).catch(err =>
          console.warn(`[wakeUp] connector auto-activate failed (${connector.id}):`, err)
        )
      }
    }
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
    const [agent, projectRow] = await Promise.all([
      getAgentById(agentId),
      getProjectById(projectId),
    ])
    if (!agent) {
      runtime.removeAgent(agentId)
      return
    }
    const storage = this.storages.get(projectId) ?? new StudioStorageAdapter(projectId)
    const projectMemoryConfig = (projectRow?.memory_config as import('@jiku/types').ProjectMemoryConfig | null)
      ?? DEFAULT_PROJECT_MEMORY_CONFIG
    const agentMemoryConfig = resolveMemoryConfig(
      projectMemoryConfig,
      (agent.memory_config as AgentMemoryConfig | null) ?? null,
    )
    const memoryTools = buildMemoryTools(agentMemoryConfig, storage, projectId)
    const runTaskTool = buildRunTaskTool(projectId, agent.id, () => ({
      user_id: 'system', roles: [], permissions: [], user_data: {},
    }), () => undefined)

    runtime.addAgent(
      defineAgent({
        meta: { id: agent.id, name: agent.name },
        base_prompt: agent.base_prompt,
        allowed_modes: (agent.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
        provider_id: DYNAMIC_PROVIDER_ID,
        model_id: DYNAMIC_MODEL_ID,
        compaction_threshold: agent.compaction_threshold ?? 80,
        built_in_tools: [...memoryTools, runTaskTool],
      }),
      agentMemoryConfig,
      (agent.persona_seed ?? null) as import('@jiku/types').PersonaSeed | null,
      (agent as Record<string, unknown>).persona_prompt as string | null ?? null,
    )

    // Reschedule heartbeat if config changed
    await heartbeatScheduler.rescheduleAgent(agent.id, projectId)
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
   * Activate a plugin for a project.
   * Updates the enabled set and triggers the lifecycle hook.
   */
  async activatePlugin(projectId: string, pluginId: string, config: Record<string, unknown>): Promise<void> {
    const loader = this._pluginLoader
    if (!loader) return

    await loader.activatePlugin(projectId, pluginId, config)
    // Note: getResolvedTools(projectId) will now include the newly enabled plugin's tools
    // No need to restart runtime — tools are resolved dynamically per request
  }

  /**
   * Deactivate a plugin for a project.
   * Loads the current config from DB so the lifecycle hook receives it.
   */
  async deactivatePlugin(projectId: string, pluginId: string): Promise<void> {
    const loader = this._pluginLoader
    if (!loader) return

    await loader.deactivatePlugin(projectId, pluginId)
  }

  /**
   * Rebuild the effective tool/prompt set for a project after plugin changes.
   * Since tools are resolved dynamically via getResolvedTools(projectId),
   * this is a no-op in the current architecture but kept as a sync point
   * for future use (e.g. hot-reloading runtimes).
   */
  async syncProjectTools(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime || !this._pluginLoader) return
    // Tools are already resolved dynamically — no rebuild needed
    console.log(`[jiku] syncProjectTools: ${projectId} tools synced`)
  }

  /**
   * Run an agent within a project runtime.
   * Resolves the credential per-request (decrypted keys never sit in long-lived memory).
   */
  async run(projectId: string, params: JikuRunParams): Promise<JikuRunResult> {
    const runtime = await this.getRuntime(projectId)

    // Ensure persona seed is applied before first run (no-op if already seeded)
    if (this.storages.has(projectId)) {
      const storage = this.storages.get(projectId)
      if (storage) {
        const selfMems = await storage.getMemories({ runtime_id: projectId, agent_id: params.agent_id, scope: 'agent_self' })
        await ensurePersonaSeeded(params.agent_id, projectId, selfMems.length > 0)
      }
    }

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
    heartbeatScheduler.stopAll()

    await Promise.all(
      Array.from(this.runtimes.entries()).map(([, rt]) => rt.stop()),
    )
    this.runtimes.clear()
    this.storages.clear()

    // Trigger onServerStop lifecycle for all registered plugins
    if (this._pluginLoader) {
      await this._pluginLoader.stopPlugins()
    }
  }
}

export const runtimeManager = new JikuRuntimeManager()
