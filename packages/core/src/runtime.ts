import type {
  AgentDefinition,
  JikuRunParams,
  JikuRunResult,
  JikuRuntimeOptions,
  PolicyRule,
  JikuStorageAdapter,
} from '@jiku/types'
import { AgentRunner } from './runner.ts'
import { ModelProviders } from './providers.ts'
import type { PluginLoader } from './plugins/loader.ts'

export class JikuRuntime {
  private agents = new Map<string, AgentRunner>()
  private rules: PolicyRule[]
  private storage: JikuStorageAdapter
  private plugins: PluginLoader
  private providers: ModelProviders

  constructor(
    options: Omit<JikuRuntimeOptions, 'plugins'> & {
      plugins: PluginLoader
    }
  ) {
    this.rules = options.rules ?? []
    this.storage = options.storage
    this.plugins = options.plugins
    this.providers = new ModelProviders(
      options.providers ?? {},
      options.default_provider,
    )
  }

  addAgent(def: AgentDefinition): void {
    const runner = new AgentRunner(def, this.plugins, this.storage, this.providers)
    this.agents.set(def.meta.id, runner)
  }

  removeAgent(agent_id: string): void {
    this.agents.delete(agent_id)
  }

  updateRules(rules: PolicyRule[]): void {
    this.rules = rules
  }

  async run(params: JikuRunParams): Promise<JikuRunResult> {
    const runner = this.agents.get(params.agent_id)
    if (!runner) throw new Error(`Agent '${params.agent_id}' not found`)
    return runner.run({ ...params, rules: this.rules })
  }

  async boot(): Promise<void> {
    this.plugins.setStorage(this.storage)
    await this.plugins.boot()
  }

  async stop(): Promise<void> {
    await this.plugins.stop()
  }
}
