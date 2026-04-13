import type {
  AgentMode,
  AgentModeConfig,
  JikuRunParams,
  JikuStorageAdapter,
  RuntimeContext,
  ResolvedTool,
  PolicyRule,
  SubjectMatcher,
  JikuStreamWriter,
} from '@jiku/types'
import type { ModelMessage, ToolSet, StepResult } from 'ai'
import type { JikuUIMessageStreamWriter } from './types.ts'
import type { ModelProviders } from './providers.ts'

/** Plan 21 — Public adapter metadata used for UI listings and logging. */
export interface AgentAdapterMeta {
  id: string
  displayName: string
  description: string
}

/**
 * Shared context the runner hands to an adapter. Everything needed to drive
 * an LLM call against the current conversation is pre-built here.
 */
export interface AgentRunContext {
  systemPrompt: string
  messages: ModelMessage[]
  modeTools: ResolvedTool[]
  aiTools: ToolSet
  model: ReturnType<ModelProviders['resolve']>
  maxToolCalls: number
  mode: AgentMode
  run_id: string
  conversation_id: string
  agent_id: string

  storage: JikuStorageAdapter
  runtimeCtx: RuntimeContext

  writer: JikuStreamWriter
  sdkWriter: JikuUIMessageStreamWriter

  modeConfig?: AgentModeConfig

  emitUsage(usage: { inputTokens?: number; outputTokens?: number }): void
  persistAssistantMessage(steps: StepResult<ToolSet>[]): Promise<void>
}

export interface AgentAdapter extends AgentAdapterMeta {
  /** JSON Schema (draft-07) describing this adapter's config object. */
  configSchema: Record<string, unknown>

  execute(
    ctx: AgentRunContext,
    params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher },
  ): Promise<void>
}

/** Minimal adapter registry surface consumed by the runner. */
export interface AgentAdapterRegistryLike {
  resolve(id: string): AgentAdapter
}
