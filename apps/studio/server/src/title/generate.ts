import { generateText } from 'ai'
import { updateConversationTitle } from '@jiku-studio/db'
import { resolveAgentModel, buildProvider } from '../credentials/service.ts'

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

    const { text } = await generateText({
      model,
      system: 'Generate a very short conversation title (maximum 50 characters) based on the user\'s first message. Return only the title text, nothing else.',
      prompt: userMessage,
    })

    const title = text.trim().slice(0, 50)
    if (!title) return

    await updateConversationTitle(conversationId, title)
  } catch {
    // Title generation is non-critical — suppress all errors
  }
}
