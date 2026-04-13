import type { AgentMode, ResolvedTool, CallerContext } from '@jiku/types'

/**
 * Build the mode-specific instruction segment.
 */
export function buildModeInstruction(mode: AgentMode): string {
  if (mode === 'chat') {
    return 'You are having a conversation with the user. Be helpful, concise, and responsive.'
  }
  return 'You are working autonomously on a goal. Complete the task thoroughly and produce a clear, structured output.'
}

/**
 * Build the user context segment.
 */
export function buildUserContext(caller: CallerContext): string {
  const name = (caller.user_data.name as string | undefined) ?? caller.user_id
  const email = caller.user_data.email as string | undefined
  const roles = caller.roles.join(', ') || 'user'
  const parts = [`name: ${name}`, `id: ${caller.user_id}`]
  if (email) parts.push(`email: ${email}`)
  parts.push(`roles: ${roles}`)
  return `Current user — ${parts.join(', ')}`
}

/**
 * Build tool hint segments from active tools that have prompts.
 */
export function buildToolHints(tools: ResolvedTool[]): string {
  return tools
    .filter(t => t.prompt)
    .map(t => t.prompt as string)
    .join('\n')
}

/**
 * Build the full system prompt by assembling all segments.
 * Segment order: base → persona → memory → mode → user_context → tool_hints → plugins
 */
/**
 * Strip a leading `[Section Label]` line from segment content — markdown header
 * supplied by buildSystemPrompt makes it redundant.
 */
function stripLeadingBracketLabel(content: string): string {
  return content.replace(/^\s*\[[^\]\n]+\]\s*\n+/, '')
}

export interface LabeledSegment {
  label: string
  content: string
}

/**
 * Build the full system prompt with markdown structure for clarity.
 *
 * Layout:
 *   ## Runtime Context (Priority Rules)   ← prepend_segments (HARD overrides)
 *   ### <label>
 *   ...
 *   ## Base Prompt
 *   ...
 *   ## Persona
 *   ## Skills
 *   ## Memory
 *   ## Mode
 *   ## User Context
 *   ## Tool Hints
 *   ## Plugins
 *   ### <plugin label>
 *   ## Runtime Context                    ← extra_system_segments (additive)
 *   ### <label>
 */
export function buildSystemPrompt(params: {
  base: string
  mode: AgentMode
  active_tools: ResolvedTool[]
  caller: CallerContext
  /**
   * Plugin segments. Pass `LabeledSegment[]` for proper `### <label>` headers,
   * or `string[]` for legacy unlabeled (rendered without sub-headers).
   */
  plugin_segments: string[] | LabeledSegment[]
  /** Plan 22 revision — segments inserted BEFORE base_prompt (highest precedence). */
  prepend_segments?: string[] | LabeledSegment[]
  /**
   * Plan 22 revision — runtime-injected segments (Company & Team, Project Context, etc.).
   * Rendered after Plugins under their own `## Runtime Context` heading.
   */
  runtime_segments?: string[] | LabeledSegment[]
  memory_section?: string
  persona_section?: string
  skill_section?: string
  skill_hint?: string
}): string {
  const { base, mode, active_tools, caller, plugin_segments, prepend_segments, runtime_segments, memory_section, persona_section, skill_section, skill_hint } = params

  const toLabeled = (arr: string[] | LabeledSegment[] | undefined): LabeledSegment[] => {
    if (!arr) return []
    return arr.map(s => typeof s === 'string' ? { label: '', content: s } : s)
  }

  const renderSection = (heading: string, items: LabeledSegment[]): string | null => {
    const cleaned = items
      .map(({ label, content }) => ({ label, content: stripLeadingBracketLabel(content) }))
      .filter(s => s.content.trim().length > 0)
    if (cleaned.length === 0) return null
    const blocks = cleaned.map(({ label, content }) =>
      label ? `### ${label}\n${content}` : content,
    )
    return `## ${heading}\n${blocks.join('\n\n')}`
  }

  const renderSingle = (heading: string, content: string | undefined): string | null => {
    if (!content || !content.trim()) return null
    return `## ${heading}\n${stripLeadingBracketLabel(content)}`
  }

  const sections: Array<string | null> = [
    renderSection('Runtime Context (Priority Rules)', toLabeled(prepend_segments)),
    renderSingle('Base Prompt', base),
    renderSingle('Persona', persona_section),
    renderSingle('Skills', skill_section),
    renderSingle('Memory', memory_section),
    renderSingle('Mode Instruction', buildModeInstruction(mode)),
    renderSingle('User Context', buildUserContext(caller)),
    renderSingle('Skills (on-demand hint)', skill_hint),
    renderSingle('Tool Hints', buildToolHints(active_tools)),
    renderSection('Plugins', toLabeled(plugin_segments)),
    renderSection('Runtime Context', toLabeled(runtime_segments)),
  ]

  return sections.filter(Boolean).join('\n\n')
}
