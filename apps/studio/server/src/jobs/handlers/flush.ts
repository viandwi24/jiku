import {
  getConversationById,
  saveMemory,
  getMemoriesByType,
} from '@jiku-studio/db'
import type { JobHandler } from '../worker.ts'
import { audit } from '../../audit/logger.ts'
import { createEmbeddingService } from '../../memory/embedding.ts'
import { vectorStore } from '../../memory/qdrant.ts'

interface FlushPayload {
  conversation_id: string
  agent_id: string
  project_id: string
  summary: string
  removed_count: number
}

/** Plan 19 — memory.flush — persist compaction summary as an episodic memory. */
export const flushHandler: JobHandler = async (rawPayload) => {
  const payload = rawPayload as FlushPayload
  if (!payload?.summary || payload.summary.trim().length === 0) return

  const conversation = await getConversationById(payload.conversation_id)
  if (!conversation) return

  const callerId = conversation.user_id ?? null

  // Semantic dedup — skip if a highly similar episodic memory already exists.
  const duplicate = await findSemanticDuplicate({
    project_id: payload.project_id,
    agent_id: payload.agent_id,
    caller_id: callerId,
    content: payload.summary,
    threshold: 0.9,
  })
  if (duplicate) return

  const saved = await saveMemory({
    project_id: payload.project_id,
    agent_id: payload.agent_id,
    caller_id: callerId,
    scope: 'agent_caller',
    tier: 'extended',
    content: payload.summary,
    importance: 'medium',
    visibility: 'private',
    source: 'extraction',
    memory_type: 'episodic',
    source_type: 'flush',
    score_health: 1.0,
  })

  // Fire-and-forget embedding upsert (Qdrant)
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
      console.warn('[jobs:flush] embedding upsert failed:', err instanceof Error ? err.message : err)
    }
  })()

  audit.memoryFlush(
    { actor_id: null, actor_type: 'system', project_id: payload.project_id },
    payload.conversation_id,
    { memory_id: saved.id, summary_length: payload.summary.length, removed_count: payload.removed_count },
  )
  audit.memoryWrite(
    { actor_id: null, actor_type: 'system', project_id: payload.project_id },
    saved.id,
    { memory_type: 'episodic', source_type: 'flush', scope: saved.scope },
  )
}

/**
 * Use Qdrant vector search to find a near-duplicate of this content within the same
 * agent/caller/episodic scope. Returns true if a duplicate exists above threshold.
 *
 * Graceful fallback: if embeddings/Qdrant are unavailable, return false (write proceeds).
 */
async function findSemanticDuplicate(params: {
  project_id: string
  agent_id: string
  caller_id: string | null
  content: string
  threshold: number
}): Promise<boolean> {
  try {
    const embeddingService = await createEmbeddingService(params.project_id)
    if (!embeddingService) return false

    const [vec] = await embeddingService.embed([params.content])
    if (!vec) return false

    const hits = await vectorStore.search(params.project_id, vec, 5)
    if (hits.length === 0) return false

    // Verify top hit exceeds threshold AND belongs to the same agent+caller episodic scope.
    const topIds = hits.filter(h => h.score >= params.threshold).map(h => h.id)
    if (topIds.length === 0) return false

    const candidates = await getMemoriesByType({
      project_id: params.project_id,
      memory_types: ['episodic'],
      source_types: ['flush'],
      limit: 20,
    })
    return candidates.some(m =>
      topIds.includes(m.id)
      && m.agent_id === params.agent_id
      && (m.caller_id ?? null) === params.caller_id,
    )
  } catch {
    return false
  }
}
