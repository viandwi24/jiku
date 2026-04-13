import { generateObject } from 'ai'
import { z } from 'zod'
import type { AgentMemory, ResolvedMemoryConfig, JikuStorageAdapter } from '@jiku/types'

const ExtractionSchema = z.object({
  memories: z.array(z.object({
    content: z.string().describe('Concise fact, max 100 chars'),
    scope: z.enum(['agent_caller', 'agent_global']),
    tier: z.enum(['core', 'extended']),
    importance: z.enum(['low', 'medium', 'high']),
    visibility: z.enum(['private', 'agent_shared']),
  })),
  obsolete_ids: z.array(z.string()),
})

function getTextContent(message: { role: string; parts?: unknown[]; content?: unknown }): string {
  if (message.parts && Array.isArray(message.parts)) {
    const textPart = message.parts.find(
      (p): p is { type: 'text'; text: string } =>
        typeof p === 'object' && p !== null && (p as { type: string }).type === 'text'
    )
    return textPart?.text ?? ''
  }
  if (typeof message.content === 'string') return message.content
  return ''
}

export async function extractMemoriesPostRun(params: {
  runtime_id: string
  agent_id: string
  caller_id: string
  messages: Array<{ role: string; parts?: unknown[]; content?: unknown }>
  existing_memories: AgentMemory[]
  config: ResolvedMemoryConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
  storage: JikuStorageAdapter
}): Promise<void> {
  if (!params.config.extraction.enabled) return
  if (!params.storage.saveMemory || !params.storage.deleteMemory) return

  const recentMessages = params.messages.slice(-6)
  const conversationText = recentMessages
    .map(m => `${m.role}: ${getTextContent(m)}`)
    .join('\n')
    .trim()

  if (!conversationText) return

  const existingSummary = params.existing_memories
    .filter(m => m.tier === 'core')
    .map(m => `[${m.id}] ${m.content}`)
    .join('\n')

  try {
    const { object } = await generateObject({
      model: params.model,
      schema: ExtractionSchema,
      system: `Extract worth-remembering facts from conversations.
Focus on: preferences, corrections, important facts, recurring patterns.
Skip: transient info, greetings, questions, anything already stored.
Each memory: single clear fact, max 100 chars.

SCOPE RULES (critical — do not mix these up):
- agent_caller: anything specific to THIS user — their name, preferences, allergies, habits, personal context, corrections they made. If the sentence could start with "This user...", use agent_caller.
- agent_global: general facts about the agent's domain or operating environment that apply to ALL users — NOT about any individual user. If in doubt between the two, prefer agent_caller.`,
      prompt: `Existing memories (avoid duplicates):
${existingSummary || '(none)'}

Recent conversation:
${conversationText}

Target scope: ${params.config.extraction.target_scope}`,
    })

    for (const mem of object.memories) {
      const targetScope = params.config.extraction.target_scope
      if (targetScope === 'agent_caller' && mem.scope !== 'agent_caller') continue
      if (targetScope === 'agent_global' && mem.scope !== 'agent_global') continue

      await params.storage.saveMemory!({
        runtime_id: params.runtime_id,
        agent_id: params.agent_id,
        caller_id: mem.scope === 'agent_caller' ? params.caller_id : null,
        scope: mem.scope,
        tier: mem.tier,
        content: mem.content,
        importance: mem.importance,
        visibility: mem.visibility,
        source: 'extraction',
        expires_at: null,
      })
    }

    for (const id of object.obsolete_ids) {
      await params.storage.deleteMemory!(id)
    }
  } catch (err) {
    console.warn('[memory] post-run extraction failed:', err)
  }
}
