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

// ─────────────────────────────────────────────────────────────────────────────
// Plan 23 — Message-level branching
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageWithBranchMeta {
  id: string
  conversation_id: string
  role: string
  parts: unknown
  parent_message_id: string | null
  branch_index: number
  created_at: Date | null
  sibling_count: number
  sibling_ids: string[]
  current_sibling_index: number
}

/**
 * Load the active branch path for a conversation using the stored
 * `active_tip_message_id` as the leaf. Returns messages ordered from root → tip
 * with sibling metadata attached so the UI can render branch navigators.
 */
export async function getActivePath(conversationId: string): Promise<MessageWithBranchMeta[]> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, active_tip_message_id: true },
  })
  if (!conv) return []
  const tip = conv.active_tip_message_id
  if (!tip) return []

  const rows = await db.execute<{
    id: string
    conversation_id: string
    role: string
    parts: unknown
    parent_message_id: string | null
    branch_index: number
    created_at: Date | null
    depth: number
    sibling_count: number
    sibling_ids: string[]
  }>(sql`
    WITH RECURSIVE active_path AS (
      SELECT m.*, 0 AS depth
      FROM messages m
      WHERE m.id = ${tip}
      UNION ALL
      SELECT m.*, ap.depth + 1
      FROM messages m
      INNER JOIN active_path ap ON m.id = ap.parent_message_id
    )
    SELECT
      ap.id,
      ap.conversation_id,
      ap.role,
      ap.parts,
      ap.parent_message_id,
      ap.branch_index,
      ap.created_at,
      ap.depth,
      COALESCE((
        SELECT COUNT(*)::int FROM messages s
        WHERE s.conversation_id = ap.conversation_id
          AND s.parent_message_id IS NOT DISTINCT FROM ap.parent_message_id
      ), 1) AS sibling_count,
      COALESCE((
        SELECT array_agg(s.id ORDER BY s.branch_index ASC, s.created_at ASC)
        FROM messages s
        WHERE s.conversation_id = ap.conversation_id
          AND s.parent_message_id IS NOT DISTINCT FROM ap.parent_message_id
      ), ARRAY[ap.id]) AS sibling_ids
    FROM active_path ap
    ORDER BY ap.depth DESC
  `)

  const list = (rows as unknown as { rows?: typeof rows }).rows ?? (rows as unknown as typeof rows)
  return (list as unknown as Array<{
    id: string
    conversation_id: string
    role: string
    parts: unknown
    parent_message_id: string | null
    branch_index: number
    created_at: Date | null
    sibling_count: number
    sibling_ids: string[]
  }>).map(r => ({
    id: r.id,
    conversation_id: r.conversation_id,
    role: r.role,
    parts: r.parts,
    parent_message_id: r.parent_message_id,
    branch_index: r.branch_index,
    created_at: r.created_at,
    sibling_count: Number(r.sibling_count),
    sibling_ids: r.sibling_ids ?? [r.id],
    current_sibling_index: Math.max(0, (r.sibling_ids ?? [r.id]).indexOf(r.id)),
  }))
}

/**
 * Walk parent pointers from a tip backwards and return the linear branch
 * messages root → tip (what the runner needs as model history).
 */
export async function getMessagesByPath(tipMessageId: string) {
  const rows = await db.execute<{
    id: string
    conversation_id: string
    role: string
    parts: unknown
    parent_message_id: string | null
    branch_index: number
    created_at: Date | null
    depth: number
  }>(sql`
    WITH RECURSIVE path AS (
      SELECT m.*, 0 AS depth
      FROM messages m
      WHERE m.id = ${tipMessageId}
      UNION ALL
      SELECT m.*, p.depth + 1
      FROM messages m
      INNER JOIN path p ON m.id = p.parent_message_id
    )
    SELECT * FROM path ORDER BY depth DESC
  `)
  const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[])
  return list as Array<typeof messages.$inferSelect>
}

/**
 * Latest leaf inside the subtree rooted at `rootMessageId`, picking
 * the highest `branch_index` at every descent step (ADR-064).
 */
export async function getLatestLeafInSubtree(rootMessageId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE walk AS (
      SELECT id, branch_index, created_at, 0 AS depth
      FROM messages WHERE id = ${rootMessageId}
      UNION ALL
      SELECT child.id, child.branch_index, child.created_at, w.depth + 1
      FROM messages child
      INNER JOIN walk w ON child.parent_message_id = w.id
      WHERE child.branch_index = (
        SELECT MAX(branch_index) FROM messages
        WHERE parent_message_id = w.id
      )
    )
    SELECT id FROM walk
    ORDER BY depth DESC
    LIMIT 1
  `)
  const list = (rows as unknown as { rows?: { id: string }[] }).rows ?? (rows as unknown as { id: string }[])
  return list[0]?.id ?? rootMessageId
}

/**
 * Persist a new tip selection on a conversation.
 */
export async function setActiveTip(conversationId: string, tipMessageId: string | null) {
  await db.update(conversations)
    .set({ active_tip_message_id: tipMessageId, updated_at: new Date() })
    .where(eq(conversations.id, conversationId))
}

/**
 * Insert a message with correct `branch_index` and atomically update
 * `conversations.active_tip_message_id` to the new row.
 *
 * Branching is implicit (ADR-063): if the parent already has children, the
 * new row becomes a sibling with `branch_index = max(existing) + 1`.
 */
export async function addBranchedMessage(input: {
  conversation_id: string
  parent_message_id: string | null
  role: string
  parts: unknown
}) {
  return await db.transaction(async (tx) => {
    // Compute next branch_index among siblings with the same parent.
    const siblingRows = await tx.execute<{ max: number | null }>(sql`
      SELECT MAX(branch_index) AS max FROM messages
      WHERE conversation_id = ${input.conversation_id}
        AND parent_message_id IS NOT DISTINCT FROM ${input.parent_message_id}
    `)
    const siblingList = (siblingRows as unknown as { rows?: { max: number | null }[] }).rows
      ?? (siblingRows as unknown as { max: number | null }[])
    const prevMax = siblingList[0]?.max
    const nextIndex = prevMax === null || prevMax === undefined ? 0 : Number(prevMax) + 1

    const [row] = await tx.insert(messages).values({
      conversation_id: input.conversation_id,
      parent_message_id: input.parent_message_id ?? undefined,
      role: input.role,
      parts: input.parts as NewMessage['parts'],
      branch_index: nextIndex,
    }).returning()

    await tx.update(conversations)
      .set({ active_tip_message_id: row!.id, updated_at: new Date() })
      .where(eq(conversations.id, input.conversation_id))

    return row!
  })
}

export async function getMessageById(id: string) {
  return db.query.messages.findFirst({ where: eq(messages.id, id) })
}

/**
 * True when the conversation has more than one branch at any point — used to
 * gate features that don't yet understand branching (e.g. compaction).
 */
export async function conversationHasBranching(conversationId: string): Promise<boolean> {
  const rows = await db.execute<{ has: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM messages
      WHERE conversation_id = ${conversationId}
      GROUP BY parent_message_id
      HAVING COUNT(*) > 1
    ) AS has
  `)
  const list = (rows as unknown as { rows?: { has: boolean }[] }).rows
    ?? (rows as unknown as { has: boolean }[])
  return Boolean(list[0]?.has)
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
