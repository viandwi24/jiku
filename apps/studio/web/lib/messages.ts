import type { UIMessage } from 'ai'

/**
 * DB stores tool invocations as:
 *   { type: 'tool-invocation', toolInvocationId, toolName, args, state: 'result', result }
 *
 * AI SDK v6 UIMessage parts expect:
 *   { type: 'dynamic-tool', toolCallId, toolName, state: 'output-available', input, output }
 *
 * This converts DB parts to AI SDK UI parts so the ConversationViewer renders them correctly.
 */
export function dbPartsToUIParts(parts: unknown[]): UIMessage['parts'] {
  return parts.map((p) => {
    const part = p as Record<string, unknown>

    if (part.type === 'tool-invocation') {
      const state = part.state as string
      const input = part.args
      const output = part.result

      if (state === 'result') {
        return {
          type: 'dynamic-tool',
          toolName: part.toolName as string,
          toolCallId: part.toolInvocationId as string,
          state: 'output-available',
          input,
          output,
        }
      }
      // partial-call / call state
      return {
        type: 'dynamic-tool',
        toolName: part.toolName as string,
        toolCallId: part.toolInvocationId as string,
        state: 'input-available',
        input,
      }
    }

    // text, reasoning, etc. — pass through as-is
    return p as UIMessage['parts'][number]
  })
}

export function dbMessageToUIMessage(m: {
  id: string
  role: string
  parts: unknown[]
}): UIMessage {
  return {
    id: m.id,
    role: m.role as UIMessage['role'],
    parts: dbPartsToUIParts(m.parts),
    metadata: {},
  }
}
