import type { ToolDefinition, PluginDefinition, AgentDefinition, ToolContext, RuntimeContext } from '@jiku/types'

export type { ToolDefinition, PluginDefinition, AgentDefinition, ToolContext, RuntimeContext }

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def
}

export function getJikuContext(toolCtx: ToolContext): RuntimeContext {
  return toolCtx.runtime
}
