import { generateText } from 'ai'
import { updateConversationTitle, getAgentById } from '@jiku-studio/db'
import { resolveAgentModel, buildProvider } from '../credentials/service.ts'
import { recordLLMUsage } from '../usage/tracker.ts'

/**
 * Generates a short conversation title from the first user message and saves it.
 * Fire-and-forget: all errors are silently swallowed.
 */
export async function generateConversationTitle(
  agentId: string,
  userMessage: string,
  conversationId: string,
): Promise<void> {
  try {
    const modelInfo = await resolveAgentModel(agentId)
    if (!modelInfo) return

    const model = buildProvider(modelInfo)
    const llmStart = Date.now()
    const titleSystem = 'Generate a very short conversation title (maximum 50 characters) based on the user\'s first message. Return only the title text, nothing else.'
    const { text, usage } = await generateText({
      model,
      system: titleSystem,
      prompt: userMessage,
    })
    // Best-effort: resolve project_id for the log (so project-level usage totals include title gen).
    const agent = await getAgentById(agentId).catch(() => null)
    recordLLMUsage({
      source: 'title',
      project_id: agent?.project_id ?? null,
      agent_id: agentId,
      conversation_id: conversationId,
      provider: modelInfo.adapter_id,
      model: modelInfo.model_id,
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      duration_ms: Date.now() - llmStart,
      raw_system_prompt: titleSystem,
      raw_messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: text },
      ],
    })

    const title = text.trim().slice(0, 50)
    if (!title) return

    await updateConversationTitle(conversationId, title)
  } catch {
    // Title generation is non-critical — suppress all errors
  }
}
