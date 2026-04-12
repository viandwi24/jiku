import type {
  AgentDefinition,
  JikuRunParams,
  JikuRunResult,
  JikuRuntimeOptions,
  PolicyRule,
  SubjectMatcher,
  JikuStorageAdapter,
  PreviewRunResult,
  ResolvedMemoryConfig,
  PersonaSeed,
  ToolHooks,
} from '@jiku/types'
import { AgentRunner, type CompactionHook, type FinalizeHook } from './runner.ts'
import { ModelProviders } from './providers.ts'
import { defaultSubjectMatcher } from './resolver/access.ts'
import type { PluginLoader } from './plugins/loader.ts'

export class JikuRuntime {
  private agents = new Map<string, AgentRunner>()
  private rules: PolicyRule[]
  private storage: JikuStorageAdapter
  private plugins: PluginLoader
  private providers: ModelProviders
  private subjectMatcher: SubjectMatcher
  private runtimeId?: string
  private toolHooks?: ToolHooks
  private compactionHook?: CompactionHook
  private finalizeHook?: FinalizeHook

  constructor(
    options: Omit<JikuRuntimeOptions, 'plugins'> & {
      plugins: PluginLoader
      runtime_id?: string
    }
  ) {
    this.rules = options.rules ?? []
    this.storage = options.storage
    this.plugins = options.plugins
    this.providers = new ModelProviders(
      options.providers ?? {},
      options.default_provider,
    )
    this.subjectMatcher = options.subject_matcher ?? defaultSubjectMatcher
    this.runtimeId = options.runtime_id
    this.toolHooks = options.tool_hooks
  }

  setToolHooks(hooks: ToolHooks | undefined): void {
    this.toolHooks = hooks
    for (const runner of this.agents.values()) runner.setToolHooks(hooks)
  }

  /** Plan 19 — fired after compaction writes a summary. Propagates to all agents. */
  setCompactionHook(hook: CompactionHook | undefined): void {
    this.compactionHook = hook
    for (const runner of this.agents.values()) runner.setCompactionHook(hook)
  }

  /** Plan 19 — fired after run stream closes. Propagates to all agents. */
  setFinalizeHook(hook: FinalizeHook | undefined): void {
    this.finalizeHook = hook
    for (const runner of this.agents.values()) runner.setFinalizeHook(hook)
  }

  /** Plan 18 — list all registered agent IDs. */
  getAgentIds(): string[] {
    return Array.from(this.agents.keys())
  }

  addAgent(def: AgentDefinition, memoryConfig?: ResolvedMemoryConfig, personaSeed?: PersonaSeed | null, personaPrompt?: string | null, skillSection?: string | null, skillHint?: string | null): void {
    const runner = new AgentRunner(def, this.plugins, this.storage, this.providers, memoryConfig, this.runtimeId, personaSeed, personaPrompt, skillSection, skillHint)
    runner.setToolHooks(this.toolHooks)
    runner.setCompactionHook(this.compactionHook)
    runner.setFinalizeHook(this.finalizeHook)
    this.agents.set(def.meta.id, runner)
  }

  removeAgent(agent_id: string): void {
    this.agents.delete(agent_id)
  }

  /**
   * Update policy rules at runtime.
   * Call this only when an admin changes a policy — not per-request.
   */
  updateRules(rules: PolicyRule[]): void {
    this.rules = rules
  }

  async run(params: JikuRunParams): Promise<JikuRunResult> {
    const runner = this.agents.get(params.agent_id)
    if (!runner) throw new Error(`Agent '${params.agent_id}' not found`)
    return runner.run({
      ...params,
      rules: this.rules,
      subject_matcher: this.subjectMatcher,
    })
  }

  async previewRun(params: {
    agent_id: string
    caller: JikuRunParams['caller']
    mode: JikuRunParams['mode']
    conversation_id?: string
  }): Promise<PreviewRunResult> {
    const runner = this.agents.get(params.agent_id)
    if (!runner) throw new Error(`Agent '${params.agent_id}' not found`)
    return runner.previewRun({
      caller: params.caller,
      mode: params.mode,
      conversation_id: params.conversation_id,
      rules: this.rules,
      subject_matcher: this.subjectMatcher,
    })
  }

  async boot(): Promise<void> {
    this.plugins.setStorage(this.storage)
    await this.plugins.boot()
  }

  async stop(): Promise<void> {
    await this.plugins.stop()
  }
}
