import {
  getConversationById,
  getMessages,
  addMessage,
  createConversation,
  updateConversation,
  updateConversationTitle,
  listConversationsByAgent,
  deleteMessagesByIds,
  replaceMessages as dbReplaceMessages,
  getActivePath as dbGetActivePath,
  getMessagesByPath as dbGetMessagesByPath,
  addBranchedMessage as dbAddBranchedMessage,
  setActiveTip as dbSetActiveTip,
  pluginKvGet,
  pluginKvSet,
  pluginKvDelete,
  pluginKvKeys,
  getMemories as dbGetMemories,
  saveMemory as dbSaveMemory,
  updateMemory as dbUpdateMemory,
  deleteMemory as dbDeleteMemory,
  touchMemories as dbTouchMemories,
} from '@jiku-studio/db'
import type {
  JikuStorageAdapter,
  Conversation,
  Message,
  MessagePart,
  AgentMemory,
  MemoryScope,
  MemoryTier,
  MemoryVisibility,
} from '@jiku/types'
import { createEmbeddingService } from '../memory/embedding.ts'
import { vectorStore } from '../memory/qdrant.ts'

function toJikuConversation(row: {
  id: string
  agent_id: string
  mode: string
  title?: string | null
  status: string
  goal?: string | null
  active_tip_message_id?: string | null
  created_at: Date | null
  updated_at?: Date | null
}): Conversation {
  return {
    id: row.id,
    agent_id: row.agent_id,
    mode: (row.mode === 'task' ? 'task' : 'chat') as Conversation['mode'],
    status: (row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'active'),
    goal: row.goal ?? undefined,
    title: row.title ?? undefined,
    active_tip_message_id: row.active_tip_message_id ?? null,
    created_at: row.created_at ?? new Date(),
    updated_at: row.updated_at ?? new Date(),
  }
}

function toJikuMessage(row: {
  id: string
  conversation_id: string
  role: string
  parts: unknown
  parent_message_id?: string | null
  branch_index?: number
  created_at: Date | null
}): Message {
  let parts: MessagePart[]
  if (Array.isArray(row.parts)) {
    parts = row.parts as MessagePart[]
  } else if (typeof row.parts === 'string') {
    parts = [{ type: 'text', text: row.parts }]
  } else {
    parts = [{ type: 'text', text: String(row.parts) }]
  }

  const role = row.role === 'assistant' ? 'assistant'
    : row.role === 'tool' ? 'tool'
    : 'user'

  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role,
    parts,
    parent_message_id: row.parent_message_id ?? null,
    branch_index: row.branch_index ?? 0,
    created_at: row.created_at ?? new Date(),
  }
}

function toAgentMemory(row: {
  id: string
  project_id: string
  agent_id: string
  caller_id: string | null
  scope: string
  tier: string
  section?: string | null
  content: string
  importance: string
  visibility: string
  source: string
  memory_type?: string
  score_health?: number
  source_type?: string
  access_count: number
  last_accessed: Date | null
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}): AgentMemory {
  return {
    id: row.id,
    runtime_id: row.project_id,
    agent_id: row.agent_id,
    caller_id: row.caller_id,
    scope: row.scope as AgentMemory['scope'],
    tier: row.tier as AgentMemory['tier'],
    section: row.section ?? undefined,
    content: row.content,
    importance: row.importance as AgentMemory['importance'],
    visibility: row.visibility as AgentMemory['visibility'],
    source: row.source as AgentMemory['source'],
    memory_type: (row.memory_type ?? 'semantic') as AgentMemory['memory_type'],
    score_health: row.score_health ?? 1.0,
    source_type: (row.source_type ?? 'tool') as AgentMemory['source_type'],
    access_count: row.access_count,
    last_accessed: row.last_accessed,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * StudioStorageAdapter — implements @jiku/types JikuStorageAdapter
 * using @jiku-studio/db queries backed by PostgreSQL.
 *
 * Plugin KV store is persisted in the `plugin_kv` table, scoped by projectId.
 */
export class StudioStorageAdapter implements JikuStorageAdapter {
  constructor(private readonly projectId: string) {}

  async getConversation(id: string): Promise<Conversation | null> {
    const row = await getConversationById(id)
    return row ? toJikuConversation(row) : null
  }

  async createConversation(data: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>): Promise<Conversation> {
    const row = await createConversation({
      agent_id: data.agent_id,
      user_id: (data as Record<string, unknown>)['user_id'] as string ?? 'system',
      mode: data.mode,
      status: data.status,
      goal: data.goal,
      title: data.title,
    })
    return toJikuConversation(row)
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<Conversation> {
    const row = await updateConversation(id, {
      status: updates.status,
      title: updates.title,
      goal: updates.goal,
    })
    return toJikuConversation(row!)
  }

  async listConversations(agent_id: string): Promise<Conversation[]> {
    const rows = await listConversationsByAgent(agent_id)
    return rows.map(toJikuConversation)
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    const rows = await getMessages(conversationId)
    return rows.map(toJikuMessage)
  }

  async addMessage(conversationId: string, message: Omit<Message, 'id' | 'created_at'>): Promise<Message> {
    const row = await addMessage({
      conversation_id: conversationId,
      role: message.role,
      parts: message.parts,
    })
    return toJikuMessage(row)
  }

  async deleteMessages(_conversationId: string, ids: string[]): Promise<void> {
    await deleteMessagesByIds(ids)
  }

  async replaceMessages(conversationId: string, msgs: Omit<Message, 'id' | 'created_at'>[]): Promise<Message[]> {
    const rows = await dbReplaceMessages(
      conversationId,
      msgs.map(m => ({
        conversation_id: conversationId,
        role: m.role,
        parts: m.parts,
      })),
    )
    return rows.map(toJikuMessage)
  }

  // ── Plan 23 — branching ──────────────────────────────────────────────────

  async getActivePathMessages(conversationId: string): Promise<Message[]> {
    const rows = await dbGetActivePath(conversationId)
    return rows.map(r => toJikuMessage({
      id: r.id,
      conversation_id: r.conversation_id,
      role: r.role,
      parts: r.parts,
      parent_message_id: r.parent_message_id,
      branch_index: r.branch_index,
      created_at: r.created_at,
    }))
  }

  async getMessagesByPath(tipMessageId: string): Promise<Message[]> {
    const rows = await dbGetMessagesByPath(tipMessageId)
    return rows.map(r => toJikuMessage(r))
  }

  async addBranchedMessage(input: {
    conversation_id: string
    parent_message_id: string | null
    role: Message['role']
    parts: Message['parts']
  }): Promise<Message> {
    const row = await dbAddBranchedMessage({
      conversation_id: input.conversation_id,
      parent_message_id: input.parent_message_id,
      role: input.role,
      parts: input.parts,
    })
    return toJikuMessage(row)
  }

  async setActiveTip(conversationId: string, tipMessageId: string | null): Promise<void> {
    await dbSetActiveTip(conversationId, tipMessageId)
  }

  async pluginGet(scope: string, key: string): Promise<unknown> {
    return pluginKvGet(this.projectId, scope, key)
  }

  async pluginSet(scope: string, key: string, value: unknown): Promise<void> {
    await pluginKvSet(this.projectId, scope, key, value)
  }

  async pluginDelete(scope: string, key: string): Promise<void> {
    await pluginKvDelete(this.projectId, scope, key)
  }

  async pluginKeys(scope: string, prefix?: string): Promise<string[]> {
    return pluginKvKeys(this.projectId, scope, prefix)
  }

  async getMemories(params: {
    runtime_id: string
    agent_id?: string
    caller_id?: string
    scope?: MemoryScope | MemoryScope[]
    tier?: MemoryTier
    visibility?: MemoryVisibility[]
  }): Promise<AgentMemory[]> {
    const rows = await dbGetMemories({
      project_id: params.runtime_id,
      agent_id: params.agent_id,
      caller_id: params.caller_id,
      scope: params.scope as Parameters<typeof dbGetMemories>[0]['scope'],
      tier: params.tier as Parameters<typeof dbGetMemories>[0]['tier'],
      visibility: params.visibility as Parameters<typeof dbGetMemories>[0]['visibility'],
    })
    return rows.map(toAgentMemory)
  }

  async saveMemory(memory: Omit<AgentMemory,
    'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'
  > & Partial<Pick<AgentMemory, 'memory_type' | 'score_health' | 'source_type'>>): Promise<AgentMemory> {
    const row = await dbSaveMemory({
      project_id: memory.runtime_id,
      agent_id: memory.agent_id,
      caller_id: memory.caller_id ?? undefined,
      scope: memory.scope,
      tier: memory.tier,
      section: memory.section,
      content: memory.content,
      importance: memory.importance,
      visibility: memory.visibility,
      source: memory.source,
      memory_type: memory.memory_type ?? 'semantic',
      score_health: memory.score_health ?? 1.0,
      source_type: memory.source_type ?? 'tool',
      expires_at: memory.expires_at ?? undefined,
    })
    const saved = toAgentMemory(row)

    // Plan 15.2: Upsert embedding to Qdrant (fire-and-forget, graceful fallback)
    this.upsertEmbedding(saved).catch(err =>
      console.warn('[memory] embedding upsert failed:', err instanceof Error ? err.message : err)
    )

    return saved
  }

  /** Generate embedding and upsert to Qdrant for semantic search. */
  private async upsertEmbedding(memory: AgentMemory): Promise<void> {
    const embeddingService = await createEmbeddingService(this.projectId)
    if (!embeddingService) return

    await vectorStore.ensureCollection(this.projectId, embeddingService.dimensions)
    const [embedding] = await embeddingService.embed([memory.content])
    if (!embedding) return

    await vectorStore.upsert(this.projectId, memory.id, embedding, {
      agent_id: memory.agent_id,
      scope: memory.scope,
      tier: memory.tier,
      caller_id: memory.caller_id ?? '',
    })
  }

  async updateMemory(id: string, data: Partial<Pick<AgentMemory,
    'content' | 'importance' | 'visibility' | 'expires_at' | 'score_health' | 'memory_type'
  >>): Promise<void> {
    await dbUpdateMemory(id, data)
  }

  async deleteMemory(id: string): Promise<void> {
    await dbDeleteMemory(id)
    // Plan 15.2: Remove from Qdrant (fire-and-forget)
    vectorStore.delete(this.projectId, id).catch(() => {})
  }

  async touchMemories(ids: string[]): Promise<void> {
    await dbTouchMemories(ids)
  }
}
