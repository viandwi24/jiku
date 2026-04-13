import { generateText } from 'ai'
import {
  getAgentById,
  getConversationById,
  getMessages,
  saveMemory,
} from '@jiku-studio/db'
import type { AgentMemoryConfig, ReflectionConfig } from '@jiku/types'
import type { JobHandler } from '../worker.ts'
import { resolveAgentModel, buildProvider } from '../../credentials/service.ts'
import { createEmbeddingService } from '../../memory/embedding.ts'
import { vectorStore } from '../../memory/qdrant.ts'
import { audit } from '../../audit/logger.ts'
import { recordLLMUsage } from '../../usage/tracker.ts'

interface ReflectionPayload {
  conversation_id: string
  agent_id: string
  project_id: string
  mode: string
  turn_count: number
}

const DEFAULT_REFLECTION: ReflectionConfig = {
  enabled: false,
  model: '',
  scope: 'agent_caller',
  min_conversation_turns: 3,
}

const INSIGHT_SYSTEM = `You are a reflection engine. Read the conversation below and extract
at most ONE learning insight about the user, the task, or recurring patterns — NOT individual
facts. Focus on preferences, behaviors, or approaches that should persist across future
conversations. If there is no clear insight worth remembering, respond with exactly: NONE.
Otherwise respond with a single concise sentence (under 200 chars).`

/** Plan 19 — memory.reflection — LLM review of a finished conversation. */
export const reflectionHandler: JobHandler = async (rawPayload) => {
  const payload = rawPayload as ReflectionPayload

  const agent = await getAgentById(payload.agent_id)
  if (!agent) return

  const memCfg = (agent.memory_config ?? {}) as AgentMemoryConfig
  const reflection: ReflectionConfig = { ...DEFAULT_REFLECTION, ...(memCfg.reflection ?? {}) }
  if (!reflection.enabled) return

  const conversation = await getConversationById(payload.conversation_id)
  if (!conversation) return

  const messages = await getMessages(payload.conversation_id)
  if (messages.length === 0) return

  // Count actual user turns in the conversation (drop [Context Summary] checkpoints).
  const userTurns = messages.filter(m => m.role === 'user').length
  if (userTurns < reflection.min_conversation_turns) {
    console.log(`[jobs:reflection] skip ${payload.conversation_id}: userTurns=${userTurns} < min=${reflection.min_conversation_turns}`)
    return
  } else {
    console.log(`[jobs:reflection] trigger reflection`)
  }

  const conversationText = messages
    .map(m => {
      const parts = (m.parts ?? []) as Array<Record<string, unknown>>
      const text = parts
        .filter(p => p['type'] === 'text')
        .map(p => String(p['text'] ?? ''))
        .join('\n')
      return `${m.role}: ${text}`
    })
    .filter(line => line.trim().length > 0)
    .join('\n')
    .slice(0, 20_000) // cap to keep reflection cheap

  if (!conversationText.trim()) return

  // Resolve model: use reflection.model override if set, else agent's own model.
  const agentModel = await resolveAgentModel(payload.agent_id)
  if (!agentModel) return
  const modelInfo = reflection.model
    ? { ...agentModel, model_id: reflection.model }
    : agentModel
  const model = buildProvider(modelInfo)

  let insight: string
  const llmStart = Date.now()
  try {
    const { text, usage } = await generateText({
      model,
      system: INSIGHT_SYSTEM,
      prompt: conversationText,
    })
    insight = text.trim()
    recordLLMUsage({
      source: 'reflection',
      project_id: payload.project_id,
      agent_id: payload.agent_id,
      conversation_id: payload.conversation_id,
      provider: modelInfo.adapter_id,
      model: modelInfo.model_id,
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      duration_ms: Date.now() - llmStart,
      raw_system_prompt: INSIGHT_SYSTEM,
      raw_messages: [
        { role: 'user', content: conversationText },
        { role: 'assistant', content: insight },
      ],
      raw_response: insight,
    })
  } catch (err) {
    console.warn('[jobs:reflection] LLM call failed:', err instanceof Error ? err.message : err)
    return
  }

  if (!insight || insight.toUpperCase().includes('NONE') && insight.length < 20) {
    audit.memoryReflectionRun(
      { actor_id: null, actor_type: 'system', project_id: payload.project_id },
      payload.conversation_id,
      { inserted: false, reason: 'no_insight' },
    )
    return
  }
  // Truncate safety
  insight = insight.slice(0, 500)

  const scope = reflection.scope
  const callerId = scope === 'agent_caller' ? (conversation.user_id ?? null) : null

  // Semantic dedup against existing reflective memories — boost existing score instead of duplicating.
  const existingId = await findReflectiveDuplicate({
    project_id: payload.project_id,
    agent_id: payload.agent_id,
    content: insight,
    threshold: 0.9,
  })
  if (existingId) {
    audit.memoryReflectionRun(
      { actor_id: null, actor_type: 'system', project_id: payload.project_id },
      payload.conversation_id,
      { inserted: false, reason: 'duplicate', existing: existingId },
    )
    return
  }

  const saved = await saveMemory({
    project_id: payload.project_id,
    agent_id: payload.agent_id,
    caller_id: callerId,
    scope,
    tier: 'extended',
    content: insight,
    importance: 'medium',
    visibility: 'private',
    source: 'extraction',
    memory_type: 'reflective',
    source_type: 'reflection',
    score_health: 1.0,
  })

  // Upsert embedding for future dedup + retrieval
  void (async () => {
    try {
      const embeddingService = await createEmbeddingService(payload.project_id)
      if (!embeddingService) return
      await vectorStore.ensureCollection(payload.project_id, embeddingService.dimensions)
      const [vec] = await embeddingService.embed([saved.content])
      if (!vec) return
      await vectorStore.upsert(payload.project_id, saved.id, vec, {
        agent_id: saved.agent_id,
        scope: saved.scope,
        tier: saved.tier,
        caller_id: saved.caller_id ?? '',
      })
    } catch (err) {
      console.warn('[jobs:reflection] embedding upsert failed:', err instanceof Error ? err.message : err)
    }
  })()

  audit.memoryReflectionRun(
    { actor_id: null, actor_type: 'system', project_id: payload.project_id },
    payload.conversation_id,
    { inserted: true, memory_id: saved.id },
  )
  audit.memoryWrite(
    { actor_id: null, actor_type: 'system', project_id: payload.project_id },
    saved.id,
    { memory_type: 'reflective', source_type: 'reflection', scope },
  )
}

async function findReflectiveDuplicate(params: {
  project_id: string
  agent_id: string
  content: string
  threshold: number
}): Promise<string | null> {
  try {
    const embeddingService = await createEmbeddingService(params.project_id)
    if (!embeddingService) return null
    const [vec] = await embeddingService.embed([params.content])
    if (!vec) return null
    const hits = await vectorStore.search(params.project_id, vec, 5)
    return hits.find(h => h.score >= params.threshold)?.id ?? null
  } catch {
    return null
  }
}
