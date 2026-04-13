import { generateText } from 'ai'
import {
  getProjectById,
  getAgentsByProjectId,
  getCredentialById,
  getMemoriesByType,
  saveMemory,
  bulkDecayHealth,
  deleteLowHealthDreamMemories,
} from '@jiku-studio/db'
import type {
  DreamingConfig,
  DreamingPhaseConfig,
  ProjectMemoryConfig,
} from '@jiku/types'
import type { JobHandler } from '../worker.ts'
import { resolveAgentModel, buildProvider } from '../../credentials/service.ts'
import { decryptFields } from '../../credentials/encryption.ts'
import { createEmbeddingService } from '../../memory/embedding.ts'
import { vectorStore } from '../../memory/qdrant.ts'
import { audit } from '../../audit/logger.ts'
import { recordLLMUsage } from '../../usage/tracker.ts'

export type DreamPhase = 'light' | 'deep' | 'rem'

interface DreamPayload {
  project_id: string
  phase: DreamPhase
}

const DEEP_DECAY_FACTOR = 0.98

/**
 * Plan 19 — memory.dream handler.
 * - light: cluster recent tool/flush memories → consolidate into semantic.
 * - deep:  synthesize last-7d episodic + top semantic → procedural/semantic + decay + cleanup.
 * - rem:   weekly cross-topic patterns → reflective.
 */
export const dreamingHandler: JobHandler = async (rawPayload) => {
  const payload = rawPayload as DreamPayload
  const project = await getProjectById(payload.project_id)
  if (!project) return

  const memConfig = (project.memory_config ?? {}) as Partial<ProjectMemoryConfig>
  const dreaming = memConfig.dreaming
  if (!dreaming?.enabled) return

  const phase = payload.phase
  const phaseCfg: DreamingPhaseConfig =
    phase === 'light' ? dreaming.light
    : phase === 'deep' ? dreaming.deep
    : dreaming.rem
  if (!phaseCfg.enabled) return

  const resolved = await resolveDreamingModel(payload.project_id, dreaming, phaseCfg)
  if (!resolved) {
    console.warn(`[jobs:dream] No model configured for ${phase} in project ${payload.project_id}. Configure credential + model in Memory → Config → Dreaming.`)
    return
  }

  const t0 = Date.now()
  let inCount = 0
  let outCount = 0

  if (phase === 'light') {
    ({ inCount, outCount } = await runLightDream(payload.project_id, resolved))
  } else if (phase === 'deep') {
    ({ inCount, outCount } = await runDeepDream(payload.project_id, resolved, dreaming))
  } else {
    ({ inCount, outCount } = await runRemDream(payload.project_id, resolved, dreaming))
  }

  audit.memoryDreamRun(
    { actor_id: null, actor_type: 'system', project_id: payload.project_id },
    phase,
    { memories_in: inCount, memories_out: outCount, duration_ms: Date.now() - t0 },
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ResolvedDreamModel { model: any; provider: string; modelId: string }

async function resolveDreamingModel(
  projectId: string,
  dreaming: DreamingConfig,
  phaseCfg: DreamingPhaseConfig,
): Promise<ResolvedDreamModel | null> {
  const credentialId = phaseCfg.credential_id ?? dreaming.credential_id
  const modelId = phaseCfg.model_id || dreaming.model_id

  if (credentialId && modelId) {
    const cred = await getCredentialById(credentialId)
    if (cred) {
      const fields = cred.fields_encrypted ? decryptFields(cred.fields_encrypted) : {}
      const metadata = (cred.metadata ?? {}) as Record<string, string>
      return {
        model: buildProvider({ adapter_id: cred.adapter_id, fields, metadata, model_id: modelId }),
        provider: cred.adapter_id,
        modelId,
      }
    }
  }

  // Legacy fallback so existing configs without credential_id don't break silently.
  const agents = await getAgentsByProjectId(projectId)
  for (const agent of agents) {
    const info = await resolveAgentModel(agent.id)
    if (info) {
      return {
        model: buildProvider(info),
        provider: info.adapter_id,
        modelId: info.model_id ?? 'unknown',
      }
    }
  }
  return null
}

/** Light dreaming: cluster last-2d tool/flush memories → consolidate into semantic. */
async function runLightDream(
  projectId: string,
  resolved: ResolvedDreamModel,
): Promise<{ inCount: number; outCount: number }> {
  const { model, provider, modelId } = resolved
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const recent = await getMemoriesByType({
    project_id: projectId,
    memory_types: ['semantic', 'episodic'],
    source_types: ['tool', 'flush'],
    since,
    limit: 200,
  })

  if (recent.length < 2) return { inCount: recent.length, outCount: 0 }

  const clusters = await clusterByEmbedding(projectId, recent, 0.85)
  let outCount = 0

  for (const cluster of clusters) {
    if (cluster.length < 2) continue
    const joined = cluster.map(m => `- ${m.content}`).join('\n').slice(0, 6000)
    try {
      const llmStart = Date.now()
      const { text, usage } = await generateText({
        model,
        system: 'You consolidate redundant memory entries into ONE concise, durable semantic memory. Output only the consolidated sentence (under 200 chars). No preamble.',
        prompt: joined,
      })
      recordLLMUsage({
        source: 'dreaming.light',
        project_id: projectId,
        provider, model: modelId,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        duration_ms: Date.now() - llmStart,
        raw_system_prompt: 'You consolidate redundant memory entries into ONE concise, durable semantic memory. Output only the consolidated sentence (under 200 chars). No preamble.',
        raw_messages: [
          { role: 'user', content: joined },
          { role: 'assistant', content: text },
        ],
        raw_response: text,
      })
      const consolidated = text.trim().slice(0, 500)
      if (!consolidated) continue

      const first = cluster[0]!
      const saved = await saveMemory({
        project_id: projectId,
        agent_id: first.agent_id,
        caller_id: first.caller_id ?? null,
        scope: first.scope as 'agent_caller' | 'agent_global' | 'runtime_global' | 'agent_self',
        tier: 'extended',
        content: consolidated,
        importance: 'medium',
        visibility: 'private',
        source: 'extraction',
        memory_type: 'semantic',
        source_type: 'dream',
        score_health: 1.0,
      })
      outCount++

      void upsertEmbedding(projectId, saved)
      audit.memoryWrite(
        { actor_id: null, actor_type: 'system', project_id: projectId },
        saved.id,
        { memory_type: 'semantic', source_type: 'dream', phase: 'light' },
      )
    } catch (err) {
      console.warn('[jobs:dream.light] LLM call failed:', err instanceof Error ? err.message : err)
    }
  }

  return { inCount: recent.length, outCount }
}

/** Deep dreaming: weekly synthesis + health decay + low-health cleanup. */
async function runDeepDream(
  projectId: string,
  resolved: ResolvedDreamModel,
  _cfg: DreamingConfig,
): Promise<{ inCount: number; outCount: number }> {
  const { model, provider, modelId } = resolved
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const episodic = await getMemoriesByType({
    project_id: projectId,
    memory_types: ['episodic'],
    since,
    limit: 300,
  })
  const semantic = await getMemoriesByType({
    project_id: projectId,
    memory_types: ['semantic'],
    limit: 200,
  })
  const pool = [...episodic, ...semantic]
  const inCount = pool.length
  let outCount = 0

  if (pool.length >= 3) {
    const joined = pool.map(m => `- [${m.memory_type}] ${m.content}`).join('\n').slice(0, 16000)
    try {
      const llmStart = Date.now()
      const { text, usage } = await generateText({
        model,
        system: 'Identify 1-5 recurring patterns, preferences, or procedures across these memories. Output each as one concise line, prefixed "PROC:" (how-to/procedure) or "FACT:" (durable semantic fact). Max 200 chars each. No preamble, no bullets.',
        prompt: joined,
      })
      recordLLMUsage({
        source: 'dreaming.deep',
        project_id: projectId,
        provider, model: modelId,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        duration_ms: Date.now() - llmStart,
        raw_system_prompt: 'Identify 1-5 recurring patterns, preferences, or procedures across these memories. Output each as one concise line, prefixed "PROC:" (how-to/procedure) or "FACT:" (durable semantic fact). Max 200 chars each. No preamble, no bullets.',
        raw_messages: [
          { role: 'user', content: joined },
          { role: 'assistant', content: text },
        ],
        raw_response: text,
      })
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5)
      const representative = pool[0]!
      for (const line of lines) {
        const isProc = line.toUpperCase().startsWith('PROC:')
        const content = line.replace(/^(PROC:|FACT:)\s*/i, '').slice(0, 400)
        if (!content) continue
        const saved = await saveMemory({
          project_id: projectId,
          agent_id: representative.agent_id,
          caller_id: null,
          scope: 'agent_global',
          tier: 'extended',
          content,
          importance: 'high',
          visibility: 'private',
          source: 'extraction',
          memory_type: isProc ? 'procedural' : 'semantic',
          source_type: 'dream',
          score_health: 1.0,
        })
        outCount++
        void upsertEmbedding(projectId, saved)
        audit.memoryWrite(
          { actor_id: null, actor_type: 'system', project_id: projectId },
          saved.id,
          { memory_type: saved.memory_type, source_type: 'dream', phase: 'deep' },
        )
      }
    } catch (err) {
      console.warn('[jobs:dream.deep] LLM call failed:', err instanceof Error ? err.message : err)
    }
  }

  // Decay all memories, then purge low-health dream-origin entries.
  await bulkDecayHealth(projectId, DEEP_DECAY_FACTOR)
  await deleteLowHealthDreamMemories(projectId, 0.1)

  return { inCount, outCount }
}

/** REM dreaming: weekly cross-topic patterns → reflective insights. */
async function runRemDream(
  projectId: string,
  resolved: ResolvedDreamModel,
  cfg: DreamingConfig,
): Promise<{ inCount: number; outCount: number }> {
  const { model, provider, modelId } = resolved
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const pool = await getMemoriesByType({
    project_id: projectId,
    memory_types: ['semantic', 'procedural'],
    since,
    limit: 500,
  })
  const inCount = pool.length
  if (pool.length < 10) return { inCount, outCount: 0 }

  const joined = pool.map(m => `- ${m.content}`).join('\n').slice(0, 20000)
  let outCount = 0
  try {
    const llmStart = Date.now()
    const { text, usage } = await generateText({
      model,
      system: `Identify cross-topic patterns, cause-effect relations, or meta-insights that are not obvious from individual memories. Only emit if the pattern is strong and meaningful. Output up to 3 lines, each starting with a confidence float 0..1 in square brackets, e.g. "[0.82] ...". Skip patterns below ${cfg.rem.min_pattern_strength}.`,
      prompt: joined,
    })
    recordLLMUsage({
      source: 'dreaming.rem',
      project_id: projectId,
      provider, model: modelId,
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      duration_ms: Date.now() - llmStart,
      raw_system_prompt: `Identify cross-topic patterns, cause-effect relations, or meta-insights that are not obvious from individual memories. Only emit if the pattern is strong and meaningful. Output up to 3 lines, each starting with a confidence float 0..1 in square brackets, e.g. "[0.82] ...". Skip patterns below ${cfg.rem.min_pattern_strength}.`,
      raw_messages: [
        { role: 'user', content: joined },
        { role: 'assistant', content: text },
      ],
      raw_response: text,
    })
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const representative = pool[0]!
    for (const line of lines) {
      const match = line.match(/^\[(\d*\.?\d+)\]\s*(.+)$/)
      if (!match) continue
      const strength = parseFloat(match[1]!)
      const content = (match[2] ?? '').slice(0, 500)
      if (strength < cfg.rem.min_pattern_strength || !content) continue

      const saved = await saveMemory({
        project_id: projectId,
        agent_id: representative.agent_id,
        caller_id: null,
        scope: 'agent_global',
        tier: 'extended',
        content,
        importance: 'high',
        visibility: 'private',
        source: 'extraction',
        memory_type: 'reflective',
        source_type: 'dream',
        score_health: 1.0,
      })
      outCount++
      void upsertEmbedding(projectId, saved)
      audit.memoryWrite(
        { actor_id: null, actor_type: 'system', project_id: projectId },
        saved.id,
        { memory_type: 'reflective', source_type: 'dream', phase: 'rem', strength },
      )
    }
  } catch (err) {
    console.warn('[jobs:dream.rem] LLM call failed:', err instanceof Error ? err.message : err)
  }

  return { inCount, outCount }
}

/** Cluster memories by embedding cosine similarity above threshold. */
async function clusterByEmbedding(
  projectId: string,
  memories: Array<{ id: string; content: string; agent_id: string; caller_id: string | null; scope: string }>,
  threshold: number,
): Promise<typeof memories[]> {
  const embeddingService = await createEmbeddingService(projectId)
  if (!embeddingService) {
    // No embeddings — fall back to grouping by trivial substring overlap (disabled by returning individually)
    return memories.map(m => [m])
  }
  try {
    const vectors = await embeddingService.embed(memories.map(m => m.content))
    const clusters: typeof memories[] = []
    const assigned = new Set<number>()
    for (let i = 0; i < memories.length; i++) {
      if (assigned.has(i)) continue
      const cluster = [memories[i]!]
      assigned.add(i)
      const vi = vectors[i]
      if (!vi) { clusters.push(cluster); continue }
      for (let j = i + 1; j < memories.length; j++) {
        if (assigned.has(j)) continue
        const vj = vectors[j]
        if (!vj) continue
        if (cosine(vi, vj) >= threshold) {
          cluster.push(memories[j]!)
          assigned.add(j)
        }
      }
      clusters.push(cluster)
    }
    return clusters
  } catch {
    return memories.map(m => [m])
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!
    dot += x * y; na += x * x; nb += y * y
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

async function upsertEmbedding(projectId: string, memory: {
  id: string
  content: string
  agent_id: string
  scope: string
  tier: string
  caller_id: string | null
}): Promise<void> {
  try {
    const embeddingService = await createEmbeddingService(projectId)
    if (!embeddingService) return
    await vectorStore.ensureCollection(projectId, embeddingService.dimensions)
    const [vec] = await embeddingService.embed([memory.content])
    if (!vec) return
    await vectorStore.upsert(projectId, memory.id, vec, {
      agent_id: memory.agent_id,
      scope: memory.scope,
      tier: memory.tier,
      caller_id: memory.caller_id ?? '',
    })
  } catch (err) {
    console.warn('[jobs:dream] embedding upsert failed:', err instanceof Error ? err.message : err)
  }
}
