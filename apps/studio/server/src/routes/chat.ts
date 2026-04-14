import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { streamRegistry } from '../runtime/stream-registry.ts'
import { conversationQueue } from '../runtime/conversation-queue.ts'
import { getConversationById, getAgentById, getProjectById, getAttachmentById } from '@jiku-studio/db'
import { recordLLMUsage } from '../usage/tracker.ts'
import { resolveAgentModel } from '../credentials/service.ts'
import { getFilesystemService } from '../filesystem/service.ts'
import { signProxyToken } from './attachments.ts'
import { evaluateAutoReply } from '../auto-reply/evaluator.ts'
import { dispatchSlashCommand } from '../commands/dispatcher.ts'
import { scanReferences } from '../references/hint.ts'
import { pipeUIMessageStreamToResponse } from 'ai'
import type { UIMessage } from 'ai'
import type { ChatAttachment, ChatFilePart, AutoReplyRule, AvailabilitySchedule, AgentQueueMode } from '@jiku/types'
import { env } from '../env.ts'
import { generateConversationTitle } from '../title/generate.ts'
import { chatRateLimit } from '../middleware/rate-limit.ts'

const router = Router()

// POST /chat requires full auth
router.post('/conversations/:id/chat', chatRateLimit, authMiddleware, async (req, res) => {
  const conversationId = String(req.params['id'])
  const userId = res.locals['user_id'] as string
  const { messages, parent_message_id } = req.body as { messages: UIMessage[]; parent_message_id?: string | null }

  const conversation = await getConversationById(conversationId)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }

  const agent = await getAgentById(conversation.agent_id)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const project = await getProjectById(agent.project_id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  let caller
  try {
    caller = await resolveCaller(userId, project.company_id, agent.id)
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Access denied' })
    return
  }

  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const lastPart = lastUser?.parts.find(p => p.type === 'text')
  const rawInput = lastPart?.type === 'text' ? lastPart.text : ''
  if (!rawInput) { res.status(400).json({ error: 'No input message found' }); return }

  // Plan 24 — slash command dispatcher: detect `/slug ...` prefix and rewrite input.
  const cmd = await dispatchSlashCommand({
    projectId: agent.project_id,
    agentId: agent.id,
    input: rawInput,
    surface: 'chat',
    userId,
  }).catch(() => ({ matched: false, resolvedInput: undefined, slug: undefined } as { matched: boolean; resolvedInput?: string; slug?: string }))

  // User input stays LITERAL — `/slug args` as typed. The resolved command
  // body (the SOP markdown the agent should follow) is injected as a per-turn
  // system segment instead of replacing the user message. Same rationale as
  // the @file hint: keeps message DB + chat UI honest about what the user
  // actually typed; edits work naturally.
  const input = rawInput
  const commandSegment = (cmd.matched && cmd.resolvedInput)
    ? [{ label: `Command Invoked: /${cmd.slug ?? ''} (this turn only)`, content: cmd.resolvedInput }]
    : undefined

  // @file reference hint — scan against the resolved command body if a command
  // matched (so `@plans/foo.md` inside the command body still resolves), else
  // against the raw user text.
  const refScan = await scanReferences({
    projectId: agent.project_id,
    text: cmd.resolvedInput ?? input,
    userId,
    surface: 'chat',
  }).catch(() => ({ hintBlock: null } as const))
  const refSegments = refScan.hintBlock
    ? [{ label: 'File mentions (this turn only)', content: refScan.hintBlock }]
    : undefined

  // Combine both per-turn segments. Either, both, or neither.
  const extraSegments = [...(commandSegment ?? []), ...(refSegments ?? [])]
  const extraSegmentsArg = extraSegments.length > 0 ? extraSegments : undefined

  // --- Auto-reply intercept: check rules before LLM invocation ---
  const autoReplyRules = (agent.auto_replies ?? []) as AutoReplyRule[]
  const availabilitySchedule = (agent.availability_schedule ?? null) as AvailabilitySchedule | null
  const autoReply = evaluateAutoReply(input, autoReplyRules, availabilitySchedule)
  if (autoReply.matched && autoReply.response) {
    // Return auto-reply as a minimal stream (text-only, no LLM)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
    const parts = [
      { type: 'message-start', id: crypto.randomUUID() },
      { type: 'text-delta', textDelta: autoReply.response },
      { type: 'message-end' },
    ]
    for (const part of parts) {
      res.write(`data: ${JSON.stringify(part)}\n\n`)
    }
    res.end()
    return
  }

  // --- Queue mode intercept: if running + queue enabled, enqueue instead of 409 ---
  const queueMode = (agent.queue_mode ?? 'off') as AgentQueueMode
  if (streamRegistry.isRunning(conversationId)) {
    if (queueMode === 'off') {
      res.status(409).json({ error: 'conversation_running', message: 'This conversation is already processing a message. Please wait.' })
      return
    }

    // Queue mode: buffer the message and wait for it to be processed
    // Note: this holds the HTTP connection open until the queued message's turn.
    // The client gets a normal stream response when the message is finally processed.
    res.status(202).json({
      queued: true,
      position: conversationQueue.queueLength(conversationId) + 1,
      message: 'Your message has been queued and will be processed shortly.',
    })
    return
  }

  // Resolve file/image attachments from the last user message.
  // FileUIPart.url can be:
  //   "attachment://{id}"  → stored attachment, resolve via DB + S3
  //   "data:..."           → legacy client-side base64 (fallback, dev only)
  const fileDelivery = (agent.file_delivery ?? 'base64') as 'base64' | 'proxy_url'
  const attachments: ChatAttachment[] = []
  const inputFileParts: ChatFilePart[] = []

  if (lastUser) {
    for (const part of lastUser.parts) {
      if (part.type !== 'file') continue
      const filePart = part as { type: 'file'; mediaType?: string; filename?: string; url?: string }
      const url = filePart.url ?? ''

      // Always collect original file parts for DB persistence
      if (url.startsWith('attachment://') || url.startsWith('data:')) {
        inputFileParts.push({
          mediaType: filePart.mediaType ?? 'application/octet-stream',
          filename: filePart.filename,
          url,
        })
      }

      if (url.startsWith('attachment://')) {
        // Resolve from DB
        const attachmentId = url.slice('attachment://'.length)
        const record = await getAttachmentById(attachmentId).catch(() => null)
        if (!record) continue

        if (fileDelivery === 'proxy_url') {
          // Generate short-lived signed proxy URL
          const token = signProxyToken(record.storage_key)
          const baseUrl = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`
          const proxyUrl = `${baseUrl}/files/view?key=${encodeURIComponent(record.storage_key)}&token=${token}`
          attachments.push({ mime_type: record.mime_type, name: record.filename, data: proxyUrl })
        } else {
          // base64: download from S3 and inline
          const fs = await getFilesystemService(record.project_id)
          if (!fs) continue
          const buffer = await fs.getAdapter().download(record.storage_key)
          const dataUri = `data:${record.mime_type};base64,${buffer.toString('base64')}`
          attachments.push({ mime_type: record.mime_type, name: record.filename, data: dataUri })
        }
      } else if (url.startsWith('data:')) {
        // Legacy inline base64 — pass through as-is
        attachments.push({
          mime_type: filePart.mediaType ?? 'application/octet-stream',
          name: filePart.filename ?? 'attachment',
          data: url,
        })
      }
    }
  }

  // Resolve model snapshot for usage log (non-blocking, best-effort)
  const modelInfo = await resolveAgentModel(agent.id).catch(() => null)
  const snapshotProviderId = modelInfo?.adapter_id ?? null
  const snapshotModelId = modelInfo?.model_id ?? null

  let result
  try {
    result = await runtimeManager.run(agent.project_id, {
      agent_id: agent.id,
      caller,
      mode: 'chat',
      input,
      attachments: attachments.length > 0 ? attachments : undefined,
      input_file_parts: inputFileParts.length > 0 ? inputFileParts : undefined,
      conversation_id: conversationId,
      extra_system_segments: extraSegmentsArg,
      // Preserve the null/undefined distinction:
      //   undefined → runner falls back to conversation.active_tip (linear extend)
      //   null      → explicit "branch at root" (edit of the first user message)
      //   uuid      → explicit branch off this parent
      parent_message_id: parent_message_id === undefined ? undefined : parent_message_id,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[chat] runtimeManager.run error:', message)
    res.status(500).json({ error: message })
    return
  }

  // Register run and get broadcast/buffer/done handles
  const { broadcast, bufferChunk, done } = streamRegistry.startRun(conversationId)

  // Tee the stream: one branch for the original caller, one for broadcasting + buffering
  const [callerStream, broadcastStream] = result.stream.tee()

  // Drain broadcast branch in background — buffer chunks + forward to SSE observers
  ;(async () => {
    let runSnapshot: { system_prompt: string; messages: unknown[]; response?: string; tools?: string[]; adapter?: string } | null = null
    const runStart = Date.now()
    try {
      const reader = broadcastStream.getReader()
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        // Accumulate in memory for polling consumers
        bufferChunk(value as Record<string, unknown>)
        // Forward to SSE observers
        const line = `data: ${JSON.stringify(value)}\n\n`
        broadcast(line)

        const chunk = value as Record<string, unknown>
        // Buffer the raw snapshot so it's available when usage arrives
        if (chunk?.type === 'data-jiku-run-snapshot') {
          runSnapshot = chunk.data as { system_prompt: string; messages: unknown[]; response?: string; tools?: string[]; adapter?: string }
        }
        // Persist usage log when we see the final usage chunk
        if (chunk?.type === 'data-jiku-usage') {
          const data = (chunk.data as { input_tokens?: number; output_tokens?: number } | undefined)
          if (data) {
            recordLLMUsage({
              source: 'chat',
              agent_id: agent.id,
              conversation_id: conversationId,
              project_id: agent.project_id,
              user_id: userId,
              mode: 'chat',
              provider: snapshotProviderId,
              model: snapshotModelId,
              input_tokens: data.input_tokens ?? 0,
              output_tokens: data.output_tokens ?? 0,
              duration_ms: Date.now() - runStart,
              raw_system_prompt: runSnapshot?.system_prompt ?? null,
              raw_messages: runSnapshot?.messages ?? null,
              raw_response: runSnapshot?.response ?? null,
              active_tools: runSnapshot?.tools ?? null,
              agent_adapter: runSnapshot?.adapter ?? null,
            })
          }
        }
      }
    } finally {
      done()
      // Fire-and-forget: generate title if conversation has none yet
      if (!conversation.title) {
        generateConversationTitle(agent.id, input, conversationId)
          .catch(() => { /* suppress */ })
      }
      // Process next queued message if any
      drainQueue(conversationId, agent.project_id).catch(err =>
        console.error('[chat] queue drain error:', err)
      )
    }
  })()

  // Pipe caller branch directly to response
  pipeUIMessageStreamToResponse({
    response: res,
    stream: callerStream as Parameters<typeof pipeUIMessageStreamToResponse>[0]['stream'],
  })
})

/**
 * GET /conversations/:id/stream
 * SSE endpoint for observers — attach to an in-progress run.
 * Returns 404 if no run is active for this conversation.
 */
router.get('/conversations/:id/stream', async (req, res) => {
  const conversationId = String(req.params['id'])

  if (!streamRegistry.isRunning(conversationId)) {
    res.status(404).json({ error: 'no_active_run', message: 'No active run for this conversation.' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  streamRegistry.subscribe(conversationId, res)
})

/**
 * GET /conversations/:id/status
 * Check whether a conversation currently has an active run.
 */
router.get('/conversations/:id/status', async (req, res) => {
  const conversationId = String(req.params['id'])
  res.json({ running: streamRegistry.isRunning(conversationId) })
})

/**
 * GET /conversations/:id/live-parts
 * Returns the in-memory chunk buffer for an active run — for polling observers.
 * Returns { running: false } if no active run (stream finished or never started).
 * Consumers should poll this at ~500ms and stop when running=false, then reload messages from DB.
 */
router.get('/conversations/:id/live-parts', async (req, res) => {
  const conversationId = String(req.params['id'])
  const buffer = streamRegistry.getBuffer(conversationId)
  if (buffer === null) {
    res.json({ running: false, chunks: [] })
    return
  }
  res.json({ running: true, chunks: buffer })
})

/**
 * Drain the conversation queue: dequeue next message and run it.
 * Called after each run completes to process queued messages FIFO.
 */
async function drainQueue(conversationId: string, projectId: string): Promise<void> {
  const next = conversationQueue.dequeue(conversationId)
  if (!next) return

  try {
    const result = await runtimeManager.run(projectId, {
      agent_id: (await getConversationById(conversationId))?.agent_id ?? '',
      caller: next.caller,
      mode: 'chat',
      input: next.input,
      attachments: next.attachments,
      input_file_parts: next.input_file_parts,
      conversation_id: conversationId,
    })

    // Register in stream registry for observers
    const { broadcast, bufferChunk, done } = streamRegistry.startRun(conversationId)
    const [observerStream, resolveStream] = result.stream.tee()

    // Drain observer branch
    ;(async () => {
      try {
        const reader = observerStream.getReader()
        while (true) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          bufferChunk(value as Record<string, unknown>)
          broadcast(`data: ${JSON.stringify(value)}\n\n`)
        }
      } finally {
        done()
        // Recursively drain next queued message
        drainQueue(conversationId, projectId).catch(err =>
          console.error('[chat] queue drain error:', err)
        )
      }
    })()

    next.resolve({ ...result, stream: resolveStream })
  } catch (err) {
    next.reject(err instanceof Error ? err : new Error(String(err)))
    // Try next in queue even if this one failed
    drainQueue(conversationId, projectId).catch(() => {})
  }
}

export { router as chatRouter }
