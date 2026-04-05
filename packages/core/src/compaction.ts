import { generateText } from 'ai'
import type { Message, MessagePart } from '@jiku/types'
import { estimateTokens } from './utils/tokens.ts'

export interface CompactResult {
  summary: string
  compacted: Omit<Message, 'id' | 'created_at'>[]
  removed_count: number
  token_saved: number
}

/**
 * Extract readable text from message parts for summarization.
 */
function getMessageText(parts: MessagePart[]): string {
  const textParts = parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('\n')

  const toolParts = parts
    .filter(p => p.type === 'tool-invocation')
    .map(p => {
      const tool = p as { type: 'tool-invocation'; toolName: string; state: string; result?: unknown }
      return `[Tool: ${tool.toolName}]${tool.state === 'result' ? ` → ${JSON.stringify(tool.result).slice(0, 200)}` : ''}`
    })
    .join(', ')

  return [textParts, toolParts].filter(Boolean).join(' ')
}

/**
 * Apply compact boundary — skip all messages before the latest checkpoint.
 * Returns only messages from the last [Context Summary] checkpoint onwards.
 */
export function applyCompactBoundary(messages: Message[]): Message[] {
  let lastCheckpointIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant') {
      const text = m.parts.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined
      if (text?.text.startsWith('[Context Summary]')) {
        lastCheckpointIdx = i
        break
      }
    }
  }
  return lastCheckpointIdx >= 0 ? messages.slice(lastCheckpointIdx) : messages
}

/**
 * Compact old messages into a checkpoint summary using an LLM.
 * Keeps `keepRecent` most recent messages verbatim, summarizes the rest.
 */
export async function compactMessages(opts: {
  messages: Message[]
  conversation_id: string
  keepRecent: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
}): Promise<CompactResult> {
  const { messages, conversation_id, keepRecent, model } = opts

  if (messages.length <= keepRecent) {
    return {
      summary: '',
      compacted: messages.map(m => ({
        conversation_id: m.conversation_id,
        role: m.role,
        parts: m.parts,
      })),
      removed_count: 0,
      token_saved: 0,
    }
  }

  const toCompact = messages.slice(0, messages.length - keepRecent)
  const toKeep = messages.slice(messages.length - keepRecent)

  // Build conversation text for summarization
  const conversationText = toCompact
    .map(m => {
      const text = getMessageText(m?.parts ?? [])
      return `${m?.role ?? 'unknown'}: ${text}`
    })
    .join('\n')

  const tokenSaved = estimateTokens(conversationText)

  const result = await generateText({
    model,
    system: `You are a conversation summarizer. Create a concise summary of the conversation history below.
Preserve: key facts, decisions made, tool results, important data points, user preferences.
Skip: greetings, filler, redundant tool calls, verbose outputs.
Write in the same language as the conversation.
Format as a brief narrative paragraph, not bullet points.`,
    prompt: conversationText,
  })

  const summary = result.text

  // Build checkpoint message (prepends toKeep)
  const checkpoint: Omit<Message, 'id' | 'created_at'> = {
    conversation_id,
    role: 'assistant',
    parts: [{ type: 'text', text: `[Context Summary]\n${summary}` }],
  }

  const compacted = [
    checkpoint,
    ...toKeep.map(m => ({
      conversation_id: m.conversation_id,
      role: m.role,
      parts: m.parts,
    })),
  ]

  return {
    summary,
    compacted,
    removed_count: toCompact.length,
    token_saved: tokenSaved,
  }
}
