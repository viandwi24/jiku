import { generateObject } from 'ai'
import { z } from 'zod'
import type { JikuStorageAdapter } from '@jiku/types'

const PersonaExtractionSchema = z.object({
  signals: z.array(z.object({
    content: z.string().describe('Concise persona signal, max 120 chars'),
    signal_type: z.enum(['communication_style', 'personality', 'preference', 'correction', 'role', 'background']),
    confidence: z.enum(['explicit', 'implicit']),
  })),
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

/**
 * Analyze conversation for persona signals (communication style, corrections, preferences).
 * Fire-and-forget — auto-extract explicit signals, skip implicit ones to avoid noise.
 */
export async function extractPersonaPostRun(params: {
  runtime_id: string
  agent_id: string
  messages: Array<{ role: string; parts?: unknown[]; content?: unknown }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
  storage: JikuStorageAdapter
}): Promise<void> {
  if (!params.storage.saveMemory) return

  const recentMessages = params.messages.slice(-6)
  if (recentMessages.length < 2) return

  const conversationText = recentMessages
    .map(m => `${m.role}: ${getTextContent(m)}`)
    .join('\n')
    .trim()

  if (!conversationText) return

  // Only trigger extraction when there are user feedback signals
  const hasPersonaSignals = recentMessages.some(m => {
    const text = getTextContent(m).toLowerCase()
    return m.role === 'user' && (
      text.includes('bisa lebih') ||
      text.includes('jangan terlalu') ||
      text.includes('lebih singkat') ||
      text.includes('lebih formal') ||
      text.includes('lebih santai') ||
      text.includes('kamu terlalu') ||
      text.includes('tolong') ||
      text.includes('be more') ||
      text.includes("don't be") ||
      text.includes('too formal') ||
      text.includes('too casual') ||
      text.includes('more concise') ||
      text.includes('your name') ||
      text.includes('kamu adalah') ||
      text.includes('namamu')
    )
  })

  if (!hasPersonaSignals) return

  try {
    const { object } = await generateObject({
      model: params.model,
      schema: PersonaExtractionSchema,
      system: `You analyze conversations to extract persona adjustment signals for an AI agent.
Look for: user feedback about agent's communication style, corrections to self-description, personality adjustments.
Only extract EXPLICIT signals the user stated directly (e.g., "be more concise", "you're too formal").
Skip implicit inferences.`,
      prompt: `Recent conversation:
${conversationText}

Extract explicit persona signals only. Each signal should describe how the agent should adjust its persona.`,
    })

    for (const signal of object.signals) {
      // Only auto-save explicit signals
      if (signal.confidence !== 'explicit') continue

      await params.storage.saveMemory!({
        runtime_id: params.runtime_id,
        agent_id: params.agent_id,
        caller_id: null,
        scope: 'agent_self',
        tier: 'core',
        content: signal.content,
        importance: 'high',
        visibility: 'private',
        source: 'extraction',
        expires_at: null,
      })
    }
  } catch (err) {
    console.warn('[persona] post-run extraction failed:', err)
  }
}
