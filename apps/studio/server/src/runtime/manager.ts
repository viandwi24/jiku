import { getAgentsByProjectId, getAgentById, loadProjectPolicyRules, getEnabledProjectPlugins, getProjectById, getConnectors, deleteConnector, getProjectBrowserConfig } from '@jiku-studio/db'
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
import { cronTaskScheduler } from '../cron/scheduler.ts'
import { buildCronCreateTool, buildCronListTool, buildCronUpdateTool, buildCronDeleteTool } from '../cron/tools.ts'
import { buildRunTaskTool, buildListAgentsTool, buildListProjectMembersTool, buildAgentReadHistoryTool } from '../task/tools.ts'
import { systemTools } from '../system/tools.ts'
import { buildBrowserTools } from '../browser/tool.js'
import { buildFilesystemTools } from '../filesystem/tools.ts'
import { getFilesystemConfig } from '@jiku-studio/db'
import type { ToolDefinition } from '@jiku/types'
import { buildSkillTools } from '../skills/tools.ts'
import { SkillService } from '../skills/service.ts'

// Sentinel model_id — the dynamic provider resolves the model from the credential
const DYNAMIC_MODEL_ID = '__dynamic__'
const DYNAMIC_PROVIDER_ID = '__studio__'

/** Project-level shared tools (connector + browser + filesystem).
 *  Rebuilt whenever any of those configs change via syncProjectTools(). */
interface ProjectSharedTools {
  connectorTools: ToolDefinition[]
  browserTools: ToolDefinition[]
  filesystemTools: ToolDefinition[]
}

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

  // Per-project shared tools cache — rebuilt on syncProjectTools()
  private sharedToolsCache = new Map<string, ProjectSharedTools>()

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

  // ─── Shared tools resolution ──────────────────────────────────────────────

  /**
   * Load project-level shared tools from DB (connector, browser, filesystem).
   * Updates the cache and returns the result.
   * Does NOT restart the browser server — caller is responsible.
   */
  private async resolveSharedTools(projectId: string): Promise<ProjectSharedTools> {
    // Connector tools
    const connectorRows = await getConnectors(projectId)
    const connectorTools = connectorRows.length > 0 ? buildConnectorTools(projectId) : []

    // Browser tools
    let browserTools: ToolDefinition[] = []
    const browserCfg = await getProjectBrowserConfig(projectId)
    if (browserCfg.enabled) {
      try {
        browserTools = buildBrowserTools(projectId, browserCfg.config)
        console.log(`[browser] Project ${projectId} browser tools enabled`)
      } catch (err) {
        console.warn(`[browser] Failed to build browser tools for project ${projectId}:`, err)
      }
    }

    // Filesystem tools
    let filesystemTools: ToolDefinition[] = []
    const fsCfg = await getFilesystemConfig(projectId)
    if (fsCfg?.enabled && fsCfg.credential_id) {
      filesystemTools = buildFilesystemTools(projectId)
      console.log(`[filesystem] Project ${projectId} filesystem tools enabled`)
    }

    const shared: ProjectSharedTools = { connectorTools, browserTools, filesystemTools }
    this.sharedToolsCache.set(projectId, shared)
    return shared
  }

  /** Get cached shared tools, or load them if not cached. */
  private getSharedTools(projectId: string): ProjectSharedTools {
    return this.sharedToolsCache.get(projectId) ?? { connectorTools: [], browserTools: [], filesystemTools: [] }
  }

  // ─── wakeUp / sleep ───────────────────────────────────────────────────────

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
    const enabledRows = await getEnabledProjectPlugins(projectId)
    const enabledPluginIds = enabledRows.map(r => r.plugin_id)
    pluginLoader.setProjectEnabledPlugins(projectId, enabledPluginIds)

    // Trigger onProjectPluginActivated lifecycle for each enabled plugin
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

    this.runtimes.set(projectId, runtime)
    this.storages.set(projectId, storage)

    // Resolve and cache shared tools (browser server is started here)
    const shared = await this.resolveSharedTools(projectId)

    // Plan 15.6: Load and connect MCP servers, collect tools
    let mcpTools: import('@jiku/types').ToolDefinition[] = []
    try {
      const { getMcpServersByProject } = await import('@jiku-studio/db')
      const { mcpManager } = await import('../mcp/client.ts')
      const servers = await getMcpServersByProject(projectId)
      for (const server of servers.filter(s => s.enabled)) {
        try {
          await mcpManager.connect({
            id: server.id,
            name: server.name,
            transport: server.transport as 'stdio' | 'sse' | 'streamable-http',
            config: server.config as Record<string, unknown>,
          })
        } catch (err) {
          console.warn(`[mcp] Failed to connect to ${server.name}:`, err)
        }
      }
      mcpTools = mcpManager.getAllTools()
    } catch {
      // MCP not available — graceful fallback
    }

    // Register all agents with their tools
    for (const a of agentRows) {
      const agentMemoryConfig = resolveMemoryConfig(
        projectMemoryConfig,
        (a.memory_config as AgentMemoryConfig | null) ?? null,
      )
      const memoryTools = buildMemoryTools(agentMemoryConfig, storage, projectId)
      const runTaskTool = buildRunTaskTool(projectId, a.id, () => ({
        user_id: 'system', roles: [], permissions: [], user_data: {},
      }), () => undefined)
      const listAgentsTool = buildListAgentsTool(projectId)
      const agentReadHistoryTool = buildAgentReadHistoryTool(projectId)
      const listProjectMembersTool = buildListProjectMembersTool(projectId)
      const skillTools = buildSkillTools(a.id, projectId)
      const [skillSection, skillHint] = await Promise.all([
        SkillService.buildAlwaysSkillSection(a.id),
        SkillService.buildOnDemandSkillHint(a.id),
      ])

      const cronCallerCtx = { callerId: null, callerRole: null, callerIsSuperadmin: false }
      const cronTools = (a as Record<string, unknown>).cron_task_enabled
        ? [
            buildCronCreateTool(projectId, a.id, cronCallerCtx),
            buildCronListTool(projectId, a.id),
            buildCronUpdateTool(projectId, a.id, cronCallerCtx),
            buildCronDeleteTool(projectId, a.id, cronCallerCtx),
          ]
        : []

      runtime.addAgent(
        defineAgent({
          meta: { id: a.id, name: a.name },
          base_prompt: a.base_prompt,
          allowed_modes: (a.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
          provider_id: DYNAMIC_PROVIDER_ID,
          model_id: DYNAMIC_MODEL_ID,
          compaction_threshold: a.compaction_threshold ?? 80,
          max_tool_calls: a.max_tool_calls ?? 40,
          built_in_tools: [
            ...systemTools,
            ...memoryTools,
            ...shared.connectorTools,
            ...shared.browserTools,
            ...shared.filesystemTools,
            ...skillTools,
            ...cronTools,
            ...mcpTools,
            runTaskTool,
            listAgentsTool,
            agentReadHistoryTool,
            listProjectMembersTool,
          ],
        }),
        agentMemoryConfig,
        (a.persona_seed ?? null) as import('@jiku/types').PersonaSeed | null,
        (a as Record<string, unknown>).persona_prompt as string | null ?? null,
        skillSection ?? null,
        skillHint ?? null,
      )

      if (a.heartbeat_enabled && a.heartbeat_cron) {
        heartbeatScheduler.scheduleAgent(a.id, projectId).catch(err =>
          console.warn(`[heartbeat] Failed to schedule agent ${a.id}:`, err)
        )
      }
    }

    // Load and schedule cron tasks for the project
    cronTaskScheduler.loadAndScheduleProject(projectId).catch(err =>
      console.warn(`[cron] Failed to load cron tasks for project ${projectId}:`, err)
    )

    // Cleanup + auto-activate connectors
    const connectorRows = await getConnectors(projectId)
    const { activateConnector } = await import('../connectors/activation.ts')
    for (const connector of connectorRows) {
      if (!connectorRegistry.get(connector.plugin_id)) {
        console.warn(`[wakeUp] connector plugin "${connector.plugin_id}" not found — deleting orphaned connector ${connector.id}`)
        await deleteConnector(connector.id).catch(err =>
          console.warn(`[wakeUp] failed to delete orphaned connector ${connector.id}:`, err)
        )
        continue
      }
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
    this.sharedToolsCache.delete(projectId)
  }

  // ─── Smart sync methods ───────────────────────────────────────────────────

  /**
   * Sync project-level shared tools (browser, filesystem, connectors) without
   * restarting the runtime. Re-registers all agents with the updated tool set.
   *
   * Call this whenever browser config, filesystem config, or connector config changes.
   */
  async syncProjectTools(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) return // not booted yet — tools will load on next wakeUp

    const [agentRows, projectRow] = await Promise.all([
      getAgentsByProjectId(projectId),
      getProjectById(projectId),
    ])

    // Resolve shared tools (browser, filesystem, connectors)
    const shared = await this.resolveSharedTools(projectId)
    const storage = this.storages.get(projectId) ?? new StudioStorageAdapter(projectId)
    const projectMemoryConfig = (projectRow?.memory_config as import('@jiku/types').ProjectMemoryConfig | null)
      ?? DEFAULT_PROJECT_MEMORY_CONFIG

    // Plan 15.6: Reload MCP tools
    let mcpTools: import('@jiku/types').ToolDefinition[] = []
    try {
      const { mcpManager } = await import('../mcp/client.ts')
      mcpTools = mcpManager.getAllTools()
    } catch { /* MCP not available */ }

    for (const a of agentRows) {
      const agentMemoryConfig = resolveMemoryConfig(
        projectMemoryConfig,
        (a.memory_config as AgentMemoryConfig | null) ?? null,
      )
      const memoryTools = buildMemoryTools(agentMemoryConfig, storage, projectId)
      const runTaskTool = buildRunTaskTool(projectId, a.id, () => ({
        user_id: 'system', roles: [], permissions: [], user_data: {},
      }), () => undefined)
      const listAgentsTool = buildListAgentsTool(projectId)
      const agentReadHistoryTool = buildAgentReadHistoryTool(projectId)
      const listProjectMembersTool = buildListProjectMembersTool(projectId)
      const skillTools = buildSkillTools(a.id, projectId)
      const [skillSection, skillHint] = await Promise.all([
        SkillService.buildAlwaysSkillSection(a.id),
        SkillService.buildOnDemandSkillHint(a.id),
      ])

      const cronCallerCtxSync = { callerId: null, callerRole: null, callerIsSuperadmin: false }
      const cronToolsSync = (a as Record<string, unknown>).cron_task_enabled
        ? [
            buildCronCreateTool(projectId, a.id, cronCallerCtxSync),
            buildCronListTool(projectId, a.id),
            buildCronUpdateTool(projectId, a.id, cronCallerCtxSync),
            buildCronDeleteTool(projectId, a.id, cronCallerCtxSync),
          ]
        : []

      runtime.addAgent(
        defineAgent({
          meta: { id: a.id, name: a.name },
          base_prompt: a.base_prompt,
          allowed_modes: (a.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
          provider_id: DYNAMIC_PROVIDER_ID,
          model_id: DYNAMIC_MODEL_ID,
          compaction_threshold: a.compaction_threshold ?? 80,
          max_tool_calls: a.max_tool_calls ?? 40,
          built_in_tools: [
            ...systemTools,
            ...memoryTools,
            ...shared.connectorTools,
            ...shared.browserTools,
            ...shared.filesystemTools,
            ...skillTools,
            ...cronToolsSync,
            ...mcpTools,
            runTaskTool,
            listAgentsTool,
            agentReadHistoryTool,
            listProjectMembersTool,
          ],
        }),
        agentMemoryConfig,
        (a.persona_seed ?? null) as import('@jiku/types').PersonaSeed | null,
        (a as Record<string, unknown>).persona_prompt as string | null ?? null,
        skillSection ?? null,
        skillHint ?? null,
      )
    }

    console.log(`[jiku] syncProjectTools: ${projectId} — connector=${shared.connectorTools.length} browser=${shared.browserTools.length} fs=${shared.filesystemTools.length}`)
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
    const listAgentsTool = buildListAgentsTool(projectId)
    const agentReadHistoryTool = buildAgentReadHistoryTool(projectId)
    const skillTools = buildSkillTools(agent.id, projectId)
    const [skillSection, skillHint] = await Promise.all([
      SkillService.buildAlwaysSkillSection(agent.id),
      SkillService.buildOnDemandSkillHint(agent.id),
    ])

    // Include current shared tools so syncAgent doesn't strip them
    const shared = this.getSharedTools(projectId)

    // Plan 15.6: Get current MCP tools
    let mcpToolsAgent: import('@jiku/types').ToolDefinition[] = []
    try {
      const { mcpManager } = await import('../mcp/client.ts')
      mcpToolsAgent = mcpManager.getAllTools()
    } catch { /* MCP not available */ }

    const cronCallerCtxAgent = { callerId: null, callerRole: null, callerIsSuperadmin: false }
    const cronToolsAgent = (agent as Record<string, unknown>).cron_task_enabled
      ? [
          buildCronCreateTool(projectId, agent.id, cronCallerCtxAgent),
          buildCronListTool(projectId, agent.id),
          buildCronUpdateTool(projectId, agent.id, cronCallerCtxAgent),
          buildCronDeleteTool(projectId, agent.id, cronCallerCtxAgent),
        ]
      : []

    runtime.addAgent(
      defineAgent({
        meta: { id: agent.id, name: agent.name },
        base_prompt: agent.base_prompt,
        allowed_modes: (agent.allowed_modes ?? ['chat']) as ('chat' | 'task')[],
        provider_id: DYNAMIC_PROVIDER_ID,
        model_id: DYNAMIC_MODEL_ID,
        compaction_threshold: agent.compaction_threshold ?? 80,
        max_tool_calls: agent.max_tool_calls ?? 40,
        built_in_tools: [
          ...systemTools,
          ...memoryTools,
          ...shared.connectorTools,
          ...shared.browserTools,
          ...shared.filesystemTools,
          ...skillTools,
          ...cronToolsAgent,
          ...mcpToolsAgent,
          runTaskTool,
          listAgentsTool,
          agentReadHistoryTool,
        ],
      }),
      agentMemoryConfig,
      (agent.persona_seed ?? null) as import('@jiku/types').PersonaSeed | null,
      (agent as Record<string, unknown>).persona_prompt as string | null ?? null,
      skillSection ?? null,
      skillHint ?? null,
    )

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

  // ─── Plugin lifecycle ─────────────────────────────────────────────────────

  async activatePlugin(projectId: string, pluginId: string, config: Record<string, unknown>): Promise<void> {
    const loader = this._pluginLoader
    if (!loader) return
    await loader.activatePlugin(projectId, pluginId, config)
  }

  async deactivatePlugin(projectId: string, pluginId: string): Promise<void> {
    const loader = this._pluginLoader
    if (!loader) return
    await loader.deactivatePlugin(projectId, pluginId)
  }

  // ─── Run ──────────────────────────────────────────────────────────────────

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

    // Plan 15.2: Query Qdrant for semantic scores (fire-and-forget on failure)
    let semanticScores: Map<string, number> | undefined
    if (params.input) {
      try {
        const { createEmbeddingService } = await import('../memory/embedding.ts')
        const { vectorStore } = await import('../memory/qdrant.ts')
        const embeddingService = await createEmbeddingService(projectId)
        if (embeddingService) {
          const [queryEmbedding] = await embeddingService.embed([params.input])
          if (queryEmbedding) {
            const results = await vectorStore.search(projectId, queryEmbedding, 20)
            if (results.length > 0) {
              semanticScores = new Map(results.map(r => [r.id, r.score]))
            }
          }
        }
      } catch {
        // Graceful fallback: no semantic scores, keyword scoring only
      }
    }

    // Plan 15.6: Load tool on/off states for this agent
    let toolStates = params.tool_states
    if (!toolStates) {
      try {
        const { getToolStates } = await import('@jiku-studio/db')
        toolStates = await getToolStates(projectId, params.agent_id)
      } catch {
        // Graceful fallback: if tool states unavailable, all tools enabled
      }
    }

    const cacheKey = `${params.agent_id}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    this.modelCache.set(cacheKey, buildProvider(modelInfo))

    const result = await runtime.run({
      ...params,
      provider_id: DYNAMIC_PROVIDER_ID,
      model_id: cacheKey,
      tool_states: toolStates,
      semantic_scores: semanticScores,
    })

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
    cronTaskScheduler.stopAll()

    await Promise.all(
      Array.from(this.runtimes.entries()).map(([, rt]) => rt.stop()),
    )
    this.runtimes.clear()
    this.storages.clear()
    this.sharedToolsCache.clear()

    if (this._pluginLoader) {
      await this._pluginLoader.stopPlugins()
    }
  }
}

export const runtimeManager = new JikuRuntimeManager()
