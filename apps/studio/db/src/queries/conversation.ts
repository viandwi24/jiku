import { eq, inArray, and, desc, asc, count, sql } from 'drizzle-orm'
import { db } from '../client.ts'
import { conversations, messages, agents } from '../schema/index.ts'
import type { NewConversation, NewMessage } from '../schema/index.ts'

export async function getConversationsByAgent(agentId: string, userId: string) {
  return db.query.conversations.findMany({
    where: (t, { and, eq: eqFn }) => and(eqFn(t.agent_id, agentId), eqFn(t.user_id, userId)),
    orderBy: (t, { desc }) => [desc(t.updated_at)],
  })
}

export async function getConversationById(id: string) {
  return db.query.conversations.findFirst({
    where: eq(conversations.id, id),
  })
}

export async function createConversation(data: Omit<NewConversation, 'id' | 'created_at' | 'updated_at'>) {
  const [conversation] = await db.insert(conversations).values(data).returning()
  return conversation!
}

export async function getMessages(conversationId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: (t, { asc }) => [asc(t.created_at)],
  })
}

export async function addMessage(data: Omit<NewMessage, 'id' | 'created_at'>) {
  const [message] = await db.insert(messages).values(data).returning()
  return message!
}

export async function updateConversationTitle(id: string, title: string) {
  await db.update(conversations).set({ title, updated_at: new Date() }).where(eq(conversations.id, id))
}

export async function updateConversation(id: string, updates: {
  status?: string
  title?: string
  goal?: string
  type?: string
  metadata?: Record<string, unknown>
  run_status?: string
  started_at?: Date | null
  finished_at?: Date | null
  error_message?: string | null
}) {
  const set: Record<string, unknown> = { updated_at: new Date() }
  if (updates.status !== undefined) set.status = updates.status
  if (updates.title !== undefined) set.title = updates.title
  if (updates.goal !== undefined) set.goal = updates.goal
  if (updates.type !== undefined) set.type = updates.type
  if (updates.metadata !== undefined) set.metadata = updates.metadata
  if (updates.run_status !== undefined) set.run_status = updates.run_status
  if (updates.started_at !== undefined) set.started_at = updates.started_at
  if (updates.finished_at !== undefined) set.finished_at = updates.finished_at
  if (updates.error_message !== undefined) set.error_message = updates.error_message
  await db.update(conversations).set(set).where(eq(conversations.id, id))
  return db.query.conversations.findFirst({ where: eq(conversations.id, id) })
}

export async function createTaskConversation(data: {
  agent_id: string
  project_id: string  // used to find agent later
  type: 'task' | 'heartbeat' | 'cron'
  caller_id: string | null
  parent_conversation_id: string | null
  metadata: Record<string, unknown>
}) {
  const [row] = await db.insert(conversations).values({
    agent_id: data.agent_id,
    user_id: data.caller_id ?? undefined,
    type: data.type,
    caller_id: data.caller_id ?? undefined,
    parent_conversation_id: data.parent_conversation_id ?? undefined,
    metadata: data.metadata,
    run_status: 'idle',
    status: 'active',
    mode: 'task',
  } as NewConversation).returning()
  return row!
}

export interface ListConversationsParams {
  project_id: string
  type?: string
  agent_id?: string
  run_status?: string
  page?: number
  per_page?: number
  sort?: 'created_at' | 'started_at' | 'finished_at'
  order?: 'asc' | 'desc'
}

export async function listRunsByProject(params: ListConversationsParams) {
  const page = params.page ?? 1
  const perPage = Math.min(params.per_page ?? 20, 100)
  const offset = (page - 1) * perPage
  const sortCol = params.sort ?? 'created_at'
  const orderDir = params.order ?? 'desc'

  // Get all agent IDs for this project
  const projectAgents = await db.query.agents.findMany({
    where: eq(agents.project_id, params.project_id),
    columns: { id: true },
  })
  const agentIds = projectAgents.map(a => a.id)

  if (agentIds.length === 0) {
    return { data: [], total: 0, page, per_page: perPage, total_pages: 0 }
  }

  const conditions = [inArray(conversations.agent_id, agentIds)]
  if (params.type) conditions.push(eq(conversations.type, params.type))
  if (params.agent_id) conditions.push(eq(conversations.agent_id, params.agent_id))
  if (params.run_status) conditions.push(eq(conversations.run_status, params.run_status))

  const where = conditions.length === 1 ? conditions[0]! : and(...conditions)

  const msgCountSq = db
    .select({ conversation_id: messages.conversation_id, cnt: count().as('cnt') })
    .from(messages)
    .groupBy(messages.conversation_id)
    .as('msg_counts')

  const sortExpr = sortCol === 'started_at'
    ? (orderDir === 'desc' ? desc(conversations.started_at) : asc(conversations.started_at))
    : sortCol === 'finished_at'
      ? (orderDir === 'desc' ? desc(conversations.finished_at) : asc(conversations.finished_at))
      : (orderDir === 'desc' ? desc(conversations.created_at) : asc(conversations.created_at))

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: conversations.id,
        type: conversations.type,
        run_status: conversations.run_status,
        agent_id: conversations.agent_id,
        agent_name: agents.name,
        caller_id: conversations.caller_id,
        parent_conversation_id: conversations.parent_conversation_id,
        metadata: conversations.metadata,
        started_at: conversations.started_at,
        finished_at: conversations.finished_at,
        error_message: conversations.error_message,
        created_at: conversations.created_at,
        message_count: sql<number>`coalesce(${msgCountSq.cnt}, 0)`,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agent_id, agents.id))
      .leftJoin(msgCountSq, eq(conversations.id, msgCountSq.conversation_id))
      .where(where)
      .orderBy(sortExpr)
      .limit(perPage)
      .offset(offset),

    db.select({ cnt: count() }).from(conversations).where(where),
  ])

  const total = totalRows[0]?.cnt ?? 0
  const totalPages = Math.ceil(total / perPage)

  return {
    data: rows.map(r => ({
      ...r,
      message_count: Number(r.message_count),
      duration_ms: r.started_at && r.finished_at
        ? r.finished_at.getTime() - r.started_at.getTime()
        : null,
    })),
    total,
    page,
    per_page: perPage,
    total_pages: totalPages,
  }
}

export async function listConversationsByAgent(agentId: string) {
  return db.query.conversations.findMany({
    where: eq(conversations.agent_id, agentId),
    orderBy: (t, { desc }) => [desc(t.updated_at)],
  })
}

export async function deleteMessagesByIds(ids: string[]) {
  if (ids.length === 0) return
  await db.delete(messages).where(inArray(messages.id, ids))
}

/**
 * Replace all messages in a conversation with a new set.
 * Used for context compaction checkpointing.
 */
export async function replaceMessages(
  conversationId: string,
  newMessages: Omit<NewMessage, 'id' | 'created_at'>[],
) {
  // Delete all existing messages for this conversation
  await db.delete(messages).where(eq(messages.conversation_id, conversationId))

  if (newMessages.length === 0) return []

  // Insert the new messages
  const inserted = await db.insert(messages).values(
    newMessages.map(m => ({ ...m, conversation_id: conversationId }))
  ).returning()

  return inserted
}

export async function softDeleteConversation(id: string) {
  await db.update(conversations).set({ deleted_at: new Date() }).where(eq(conversations.id, id))
}

export async function getConversationsByProject(projectId: string, userId: string) {
  const rows = await db.query.conversations.findMany({
    where: (t, { and, eq: eqFn, isNull }) => and(eqFn(t.user_id, userId), isNull(t.deleted_at)),
    with: {
      agent: true,
      messages: {
        orderBy: (t, { desc }) => [desc(t.created_at)],
        limit: 1,
      },
    },
    orderBy: (t, { desc }) => [desc(t.updated_at)],
  })

  // Filter to conversations whose agent belongs to this project
  return rows.filter(r => r.agent.project_id === projectId).map(r => ({
    ...r,
    agent: { id: r.agent.id, name: r.agent.name, slug: r.agent.slug },
    last_message: extractLastMessageText(r.messages[0]),
    messages: undefined,
  }))
}

export async function getConversationWithAgent(convId: string) {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, convId),
    with: { agent: true },
  })
  if (!row) return null
  return {
    ...row,
    agent: { id: row.agent.id, name: row.agent.name, slug: row.agent.slug },
  }
}

function extractLastMessageText(msg: typeof messages.$inferSelect | undefined): string | null {
  if (!msg) return null
  const parts = msg.parts
  if (Array.isArray(parts)) {
    const textPart = (parts as { type: string; text?: string }[]).find(p => p.type === 'text')
    return textPart?.text?.slice(0, 120) ?? null
  }
  return null
}
