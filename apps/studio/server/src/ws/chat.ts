import { getMessages, addMessage } from '@jiku-studio/db'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'

interface WsContext {
  userId: string
  conversationId: string
}

interface ChatPayload {
  input: string
  agent_id: string
  project_id: string
  company_id: string
}

export async function handleChatMessage(
  ctx: WsContext,
  send: (msg: string) => void,
  raw: string,
): Promise<void> {
  let payload: ChatPayload
  try {
    payload = JSON.parse(raw) as ChatPayload
  } catch {
    send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
    return
  }

  const { input, agent_id, project_id, company_id } = payload
  const { userId, conversationId } = ctx

  try {
    const caller = await resolveCaller(userId, company_id, agent_id)

    const runtime = await runtimeManager.getRuntime(project_id)
    const agent = runtime.agents.get(agent_id)

    if (!agent) {
      send(JSON.stringify({ type: 'error', message: 'Agent not found in runtime' }))
      return
    }

    await addMessage({ conversation_id: conversationId, role: 'user', content: input })

    const history = await getMessages(conversationId)
    const historyMessages = history.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content),
    }))

    const { Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })

    const systemPrompt = [
      agent.base_prompt,
      `\nCaller: ${caller.user_id} | Roles: ${caller.roles.join(',')} | Permissions: ${caller.permissions.join(',')}`,
    ].join('\n')

    let fullText = ''

    send(JSON.stringify({ type: 'start' }))

    const stream = await client.messages.create({
      model: agent.model_id,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        ...historyMessages,
        { role: 'user', content: input },
      ],
      stream: true,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text
        fullText += chunk
        send(JSON.stringify({ type: 'chunk', text: chunk }))
      }
    }

    await addMessage({ conversation_id: conversationId, role: 'assistant', content: fullText })

    send(JSON.stringify({ type: 'done' }))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    send(JSON.stringify({ type: 'error', message }))
  }
}
