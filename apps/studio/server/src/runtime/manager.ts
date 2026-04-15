import { getAgentsByProjectId, getAgentById, loadProjectPolicyRules, getEnabledProjectPlugins, getProjectById, getConnectors, deleteConnector, getProjectBrowserProfiles } from '@jiku-studio/db'
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
import { buildCronCreateTool, buildCronListTool, buildCronUpdateTool, buildCronDeleteTool, buildCronArchiveTool, buildCronRestoreTool } from '../cron/tools.ts'
import { buildRunTaskTool, buildListAgentsTool, buildListProjectMembersTool, buildAgentReadHistoryTool } from '../task/tools.ts'
import { systemTools } from '../system/tools.ts'
import { buildActionRequestTools } from '../action-requests/tools.ts'
import { buildBrowserTools } from '../browser/tool.ts'
import { browserTabManager } from '../browser/tab-manager.ts'
import { invalidateFilesystemCache } from '../filesystem/factory.ts'
import { buildFilesystemTools } from '../filesystem/tools.ts'
import { buildBinaryFileHints } from '../plugins/ui/fileViewAdapterRegistry.ts'
import { getFilesystemConfig } from '@jiku-studio/db'
import type { ToolDefinition } from '@jiku/types'
import { buildSkillTools } from '../skills/tools.ts'
import { SkillService } from '../skills/service.ts'
import type { ToolHooks } from '@jiku/types'
import { audit } from '../audit/logger.ts'

// Plan 18 — tool hooks factory. Writes audit log for every tool invocation /
// block / error inside the given project.
function buildToolHooks(projectId: string): ToolHooks {
  return {
    onInvoke: (info) => {
      audit.toolInvoke(
        {
          actor_id: info.caller.user_id || null,
          actor_type: info.caller.user_id ? 'user' : 'system',
          project_id: projectId,
        },
        info.tool_id,
        { agent_id: info.agent_id, plugin_id: info.plugin_id },
      )
    },
    onBlocked: (info) => {
      audit.toolBlocked(
        {
          actor_id: info.caller.user_id || null,
          actor_type: info.caller.user_id ? 'user' : 'system',
          project_id: projectId,
        },
        info.tool_id,
        info.reason,
      )
    },
    onError: (info) => {
      const message = info.error instanceof Error ? info.error.message : String(info.error)
      audit.toolBlocked(
        {
          actor_id: info.caller.user_id || null,
          actor_type: info.caller.user_id ? 'user' : 'system',
          project_id: projectId,
        },
        info.tool_id,
        `error: ${message}`,
      )
    },
  }
}

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
   *
   * Browser tools are stateless since the @jiku/browser migration — there is
   * no long-running server to start or stop here, just a CDP endpoint that the
   * tool spawns the agent-browser CLI against per command.
   */
  private async resolveSharedTools(projectId: string): Promise<ProjectSharedTools> {
    // Connector tools
    const connectorRows = await getConnectors(projectId)
    const connectorTools = connectorRows.length > 0 ? buildConnectorTools(projectId) : []

    // Browser tools — Plan 20: built from enabled browser profiles.
    let browserTools: ToolDefinition[] = []
    try {
      const profiles = await getProjectBrowserProfiles(projectId)
      const activeProfiles = profiles.filter(p => p.enabled)
      if (activeProfiles.length > 0) {
        browserTools = await buildBrowserTools(projectId)
        console.log(`[browser] Project ${projectId} — ${activeProfiles.length} active profile(s), ${browserTools.length} browser tool(s)`)
      }
    } catch (err) {
      console.warn(`[browser] Failed to build browser tools for project ${projectId}:`, err)
    }

    // Filesystem tools
    let filesystemTools: ToolDefinition[] = []
    const fsCfg = await getFilesystemConfig(projectId)
    if (fsCfg?.enabled && fsCfg.credential_id) {
      filesystemTools = buildFilesystemTools(projectId, buildBinaryFileHints())
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
      if (plugin?.onProjectPluginActivated) {
        try {
          await pluginLoader.activatePlugin(projectId, row.plugin_id, row.config ?? {}, { updateSet: false })
        } catch (err) {
          console.warn(`[jiku] Failed to activate plugin "${row.plugin_id}" for project "${projectId}":`, err)
        }
      }
      // Plan 19 — propagate skills regardless of onProjectPluginActivated presence
      await propagatePluginSkills(projectId, row.plugin_id, pluginLoader).catch(err =>
        console.warn(`[skills] propagate failed for plugin "${row.plugin_id}":`, err),
      )
    }

    // Plan 19 — sync FS-sourced skills for this project (scan /skills/, upsert cache)
    try {
      const { getSkillLoader } = await import('../skills/loader.ts')
      await getSkillLoader(projectId).syncFilesystem()
    } catch (err) {
      console.warn(`[skills] FS sync failed for project "${projectId}":`, err)
    }

    // Plan 24 — sync FS-sourced commands for this project (scan /commands/, upsert cache)
    try {
      const { getCommandLoader } = await import('../commands/loader.ts')
      await getCommandLoader(projectId).syncFilesystem()
    } catch (err) {
      console.warn(`[commands] FS sync failed for project "${projectId}":`, err)
    }

    // Dynamic provider: resolves the model from modelCache at run-time
    const dynamicProviderDef = createProviderDef(DYNAMIC_PROVIDER_ID, {
      languageModel: (model_id: string) => {
        const model = this.modelCache.get(model_id)
        if (!model) throw new Error(`[studio] Model not cached for key "${model_id}". This is a bug.`)
        return model
      },
    })

    const { agentAdapterRegistry } = await import('../agent/adapter-registry.ts')
    const runtime = new JikuRuntime({
      plugins: pluginLoader,
      storage,
      rules: Array.from(rules.values()).flat(),
      providers: { [DYNAMIC_PROVIDER_ID]: dynamicProviderDef },
      default_provider: DYNAMIC_PROVIDER_ID,
      runtime_id: projectId,
      tool_hooks: buildToolHooks(projectId),
      adapter_registry: agentAdapterRegistry,
    })

    // Plan 19 — wire compaction + finalize hooks for memory.flush / memory.reflection enqueue
    const { buildCompactionHook, buildFinalizeHook } = await import('../memory/hooks.ts')
    runtime.setCompactionHook(buildCompactionHook(projectId))
    runtime.setFinalizeHook(buildFinalizeHook(projectId))

    await runtime.boot()

    this.runtimes.set(projectId, runtime)
    this.storages.set(projectId, storage)

    // Resolve and cache shared tools (connector / browser / filesystem)
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
            buildCronArchiveTool(projectId, a.id, cronCallerCtx),
            buildCronRestoreTool(projectId, a.id, cronCallerCtx),
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
          mode_configs: (a.mode_configs ?? undefined) as import('@jiku/types').AgentDefinition['mode_configs'],
          built_in_tools: [
            ...systemTools,
            ...buildActionRequestTools(projectId),
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
    // Drop browser tab tracking — the next wakeUp() starts from a clean
    // chromium state, so any cached tab indexes would be wrong anyway.
    // Drop per-profile browser tab tracking for every profile owned by this
    // project. The next wakeUp starts from a clean chromium state anyway.
    try {
      const profiles = await getProjectBrowserProfiles(projectId)
      for (const p of profiles) browserTabManager.dropProfile(p.id)
    } catch {
      // best-effort — if the DB is gone we just leak tab tracking until the
      // idle cleanup loop catches up.
    }
    // Drop cached FilesystemService — credential may change between
    // sleep/wakeUp cycles.
    invalidateFilesystemCache(projectId)
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
            buildCronArchiveTool(projectId, a.id, cronCallerCtxSync),
            buildCronRestoreTool(projectId, a.id, cronCallerCtxSync),
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
          mode_configs: (a.mode_configs ?? undefined) as import('@jiku/types').AgentDefinition['mode_configs'],
          built_in_tools: [
            ...systemTools,
            ...buildActionRequestTools(projectId),
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
          buildCronArchiveTool(projectId, agent.id, cronCallerCtxAgent),
          buildCronRestoreTool(projectId, agent.id, cronCallerCtxAgent),
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
        mode_configs: (agent.mode_configs ?? undefined) as import('@jiku/types').AgentDefinition['mode_configs'],
        built_in_tools: [
          ...systemTools,
          ...buildActionRequestTools(projectId),
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
    // Plan 19 — propagate any skills the plugin registered during setup.
    await propagatePluginSkills(projectId, pluginId, loader)
    // Plan 18 — hot-register: immediately refresh agents' tool sets.
    await this.syncProjectTools(projectId)
  }

  async deactivatePlugin(projectId: string, pluginId: string): Promise<void> {
    const loader = this._pluginLoader
    if (!loader) return
    await loader.deactivatePlugin(projectId, pluginId)
    // Plan 19 — remove/deactivate skills contributed by this plugin for this project.
    const { getSkillLoader } = await import('../skills/loader.ts')
    await getSkillLoader(projectId).unregisterPluginSkills(pluginId).catch(err =>
      console.warn(`[skills] unregisterPluginSkills failed for ${pluginId}:`, err),
    )
    // Plan 18 — hot-unregister: re-sync so plugin tools disappear from all agents without restart.
    await this.syncProjectTools(projectId)
  }

  /**
   * Plan 18 — force unregister of browser tools for a project (e.g. when CDP
   * connection dropped). Re-syncs all agents so stale browser tools disappear.
   */
  async unregisterBrowserTools(projectId: string): Promise<void> {
    await this.syncProjectTools(projectId)
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

    // Plan 18 — enrich caller with per-member plugin permissions + superadmin flag.
    // Skip DB lookup for non-UUID caller ids (e.g. 'system' from cron/reflection jobs,
    // 'connector:<uuid>' from connector events) — these are not real user rows and would
    // throw "invalid input syntax for type uuid" on project_memberships.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    let enrichedCaller = params.caller
    try {
      const callerUserId = params.caller.user_id
      if (callerUserId && UUID_RE.test(callerUserId)) {
        const [grantedPerms, membership] = await Promise.all([
          (await import('@jiku-studio/db')).getGrantedPluginPermissions(callerUserId, projectId),
          (await import('@jiku-studio/db')).getProjectMembership(projectId, callerUserId),
        ])
        enrichedCaller = {
          ...params.caller,
          granted_plugin_permissions: grantedPerms,
          is_superadmin: membership?.is_superadmin ?? false,
        }
      }
    } catch (err) {
      console.warn('[runtime] Failed to load plugin permissions for caller:', err)
    }

    // Plan 22 revision — always append Company & Team structure for project-scoped runs.
    // Cheap (≈2 indexed queries) and gives the agent cross-user awareness without
    // registering a global plugin.
    //
    // Order: framework-supplied segments (team, project) come FIRST, then
    // caller-supplied (`params.extra_system_segments`) come LAST. Recency bias
    // in LLMs makes the LAST thing before the user message the highest-weighted
    // instruction. Per-turn segments like Active Command + @file hint live in
    // params.extra_system_segments and benefit from being the very last block
    // of the system prompt.
    const extraSegments: Array<{ label: string; content: string }> = []
    try {
      const { buildTeamStructureSegment } = await import('./team-structure.ts')
      const teamSeg = await buildTeamStructureSegment(projectId)
      if (teamSeg) extraSegments.push({ label: 'Company & Team', content: teamSeg })
    } catch (err) {
      console.warn('[runtime] Failed to build team structure segment:', err)
    }
    try {
      const { buildProjectContextSegment } = await import('./project-context.ts')
      const projSeg = await buildProjectContextSegment(projectId)
      if (projSeg) extraSegments.push({ label: 'Project Context', content: projSeg })
    } catch (err) {
      console.warn('[runtime] Failed to build project context segment:', err)
    }
    // Caller-supplied segments LAST — closest to user message = highest recency
    // weight. Active Command body lands here intentionally so the model treats
    // the SOP as "current ask", not a background framework rule.
    extraSegments.push(...(params.extra_system_segments ?? []))
    // Capability hint — must be PREPENDED before base_prompt so it overrides agent persona
    // ("I can't schedule"). Models commonly default to refusal even when the tool is registered;
    // base_prompt persona dominates plugin segments. Putting the rule at the very top of the
    // system prompt is the most reliable way to override.
    const prependSegments: Array<{ label: string; content: string }> = [...(params.extra_system_prepend ?? [])]
    // Precedence rule — always first. Tells the model how to resolve conflicts
    // between sections. Later sections win, Active Command (if present at the
    // bottom) is the highest-priority instruction for the current turn.
    prependSegments.unshift({
      label: 'Precedence',
      content: [
        '[Precedence rule — read this first]',
        'This prompt has multiple sections. When two sections conflict, the LATER section wins (recency precedence).',
        'If an "Active Command" section appears near the bottom of this prompt, it is the highest-priority instruction for the current turn and overrides any general rule stated earlier (including Scheduling Capability, plugin hints, and base persona).',
        'General rules stated early in the prompt are defaults — they apply only when no later section says otherwise.',
      ].join('\n'),
    })
    try {
      const agentRow = await getAgentById(params.agent_id)
      if (agentRow && (agentRow as Record<string, unknown>).cron_task_enabled !== false) {
        prependSegments.push({
          label: 'Scheduling Capability',
          content: [
            '[Scheduling Capability — default behavior for time-based requests; may be overridden by a later Active Command section]',
            'You have a built-in tool `cron_create` that schedules tasks for the future. It is available in your toolset — prefer it over telling the user to use an external alarm or assistant app.',
            '',
            'When the user asks for a reminder / alarm / schedule / periodic action (and no later section says otherwise):',
            '1. Read [Project Context] for the default timezone.',
            '2. Decide mode:',
            '   - `mode: "once"` — user asked for ONE specific time ("jam X", "besok", "nanti malam", "30 menit lagi") without frequency words. Default when ambiguous.',
            '   - `mode: "recurring"` — user explicitly said "tiap hari" / "setiap" / "daily" / "every ..." or is clearly asking for a periodic job.',
            '   Do not silently upgrade a one-shot request into a daily recurring schedule.',
            '3. Convert the user\'s local time to UTC.',
            '   - For `once`: set `run_at` as ISO 8601 UTC (e.g. "2026-04-14T02:00:00.000Z" for besok jam 9 WIB).',
            '   - For `recurring`: set `cron_expression` in UTC (5-field).',
            '4. Call `cron_create` with `prompt` (instruction to future-you, not the user\'s words verbatim), mode + schedule fields above, `delivery` (current connector_id + chat_id from [Connector Context]), `origin` (platform, originator name).',
            '5. Confirm in the user\'s LOCAL timezone, matching the chosen mode:',
            '   - once → "Oke, sudah ku-set pengingat untuk [tanggal/hari] jam HH.MM 👍"',
            '   - recurring → "Oke, sudah ku-set pengingat tiap hari jam HH.MM 👍"',
            '',
            'Example A — user says "ingetin aku makan malam jam 19.49" (no "tiap/setiap"):',
            '  cron_create({',
            '    name: "Pengingat makan malam",',
            '    mode: "once",',
            '    run_at: "2026-04-13T12:49:00.000Z",  // 19.49 WIB = 12.49 UTC',
            '    prompt: "Kirim pengingat ramah ke user bahwa sekarang waktunya makan malam.",',
            '    delivery: { connector_id: "<from Connector Context>", chat_id: "<from Connector Context>", platform: "Telegram" },',
            '    origin:   { platform: "Telegram", originator_display_name: "<user name>" }',
            '  })',
            '  Reply: "Oke, sudah ku-set pengingat makan malam nanti jam 19.49 WIB 👍"',
            '',
            'Example B — user says "ingetin aku makan malam TIAP HARI jam 19.49":',
            '  cron_create({ name: "Pengingat makan malam (harian)", mode: "recurring", cron_expression: "49 12 * * *", ... })',
            '  Reply: "Oke, sudah ku-set pengingat makan malam tiap hari 19.49 WIB 👍"',
            '',
            'If `cron_create` is not in your toolset, say so and ask an admin to enable cron on this agent.',
            '',
            'To change / reschedule an existing reminder: `cron_list` → find task_id → `cron_update` with new fields → confirm in local timezone. Actually call `cron_update` before confirming.',
            '',
            'To cancel / delete a reminder: `cron_list` → find task_id → `cron_delete({ task_id })` → confirm.',
            '',
            'Note: if a later Active Command section instructs you NOT to create a cron (e.g. the SOP is a direct-execution command), follow the Active Command instead — this scheduling default does not apply in that case.',
          ].join('\n'),
        })
      }
    } catch { /* ignore */ }

    const result = await runtime.run({
      ...params,
      caller: enrichedCaller,
      provider_id: DYNAMIC_PROVIDER_ID,
      model_id: cacheKey,
      tool_states: toolStates,
      semantic_scores: semanticScores,
      extra_system_segments: extraSegments.length > 0 ? extraSegments : undefined,
      extra_system_prepend: prependSegments.length > 0 ? prependSegments : undefined,
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

    // Plan 22 revision — same extra segments as run() so preview matches reality.
    const extraSegments: Array<{ label: string; content: string }> = []
    try {
      const { buildTeamStructureSegment } = await import('./team-structure.ts')
      const teamSeg = await buildTeamStructureSegment(projectId)
      if (teamSeg) extraSegments.push({ label: 'Company & Team', content: teamSeg })
    } catch (err) {
      console.warn('[runtime:preview] team segment failed:', err)
    }
    try {
      const { buildProjectContextSegment } = await import('./project-context.ts')
      const projSeg = await buildProjectContextSegment(projectId)
      if (projSeg) extraSegments.push({ label: 'Project Context', content: projSeg })
    } catch (err) {
      console.warn('[runtime:preview] project context segment failed:', err)
    }
    const previewPrepend: Array<{ label: string; content: string }> = []
    previewPrepend.push({
      label: 'Precedence',
      content: [
        '[Precedence rule — read this first]',
        'When sections of this prompt conflict, the LATER section wins. An "Active Command" section (if present near the bottom) is the highest-priority instruction for the current turn and overrides earlier general rules.',
      ].join('\n'),
    })
    try {
      const agentRow = await getAgentById(params.agent_id)
      if (agentRow && (agentRow as Record<string, unknown>).cron_task_enabled !== false) {
        previewPrepend.push({
          label: 'Scheduling Capability',
          content: [
            '[Scheduling Capability — default behavior for time-based requests; may be overridden by a later Active Command section]',
            'You have `cron_create` in your toolset. Prefer it when the user asks for reminders / alarms / schedules instead of suggesting external apps.',
            'Call `cron_create` with prompt + UTC cron_expression or run_at (converted from local time per [Project Context]) + delivery (current connector_id + chat_id). Confirm in the user\'s local timezone.',
          ].join('\n'),
        })
      }
    } catch { /* ignore */ }

    return runtime.previewRun({
      ...params,
      extra_system_segments: extraSegments.length > 0 ? extraSegments : undefined,
      extra_system_prepend: previewPrepend.length > 0 ? previewPrepend : undefined,
    })
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

/**
 * Plan 19 — After a plugin is activated for a project, forward its registered
 * skills to the project's SkillLoader. This is a no-op if the plugin registered
 * no skills in `setup()`.
 */
async function propagatePluginSkills(
  projectId: string,
  pluginId: string,
  loader: PluginLoader,
): Promise<void> {
  const specs = loader.getPluginSkills(pluginId)
  if (specs.length === 0) return
  const pluginRoot = loader.getPluginRoot(pluginId)
  const { getSkillLoader } = await import('../skills/loader.ts')
  const skillLoader = getSkillLoader(projectId)
  for (const spec of specs) {
    try {
      await skillLoader.registerPluginSkill(pluginId, spec, pluginRoot)
    } catch (err) {
      console.warn(`[skills] plugin "${pluginId}" skill "${spec.slug}" failed to register:`, err instanceof Error ? err.message : err)
    }
  }
}
