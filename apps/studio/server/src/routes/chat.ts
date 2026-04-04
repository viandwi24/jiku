import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'
import type { AppVariables } from '../types.ts'
import type { UIMessage } from 'ai'

const router = new Hono<{ Variables: AppVariables }>()

router.use('*', authMiddleware)

router.post('/conversations/:id/chat', async (c) => {
  const conversationId = c.req.param('id')
  const userId = c.get('user_id')

  const body = await c.req.json<{
    messages: UIMessage[]
    agent_id: string
    project_id: string
    company_id: string
  }>()

  const { messages, agent_id, project_id, company_id } = body

  // Resolve caller context (permissions, roles)
  const caller = await resolveCaller(userId, company_id, agent_id).catch((err) => {
    throw new Error(err instanceof Error ? err.message : 'Access denied')
  })

  // Get input text from last user message
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const lastPart = lastUser?.parts.find(p => p.type === 'text')
  const input = lastPart?.type === 'text' ? lastPart.text : ''

  if (!input) {
    return c.json({ error: 'No input message found' }, 400)
  }

  let result
  try {
    result = await runtimeManager.run(project_id, {
      agent_id,
      caller,
      mode: 'chat',
      input,
      conversation_id: conversationId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: message }, 400)
  }

  // Stream the JikuRunResult stream as a UI message stream response
  // result.stream is a ReadableStream<JikuStreamChunk> — compatible with AI SDK UIMessageStream
  return new Response(result.stream as ReadableStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'x-vercel-ai-data-stream': 'v1',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    },
  })
})

export { router as chatRouter }
