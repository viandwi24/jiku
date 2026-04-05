import { eq, inArray } from 'drizzle-orm'
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
}) {
  const set: Record<string, unknown> = { updated_at: new Date() }
  if (updates.status !== undefined) set.status = updates.status
  if (updates.title !== undefined) set.title = updates.title
  if (updates.goal !== undefined) set.goal = updates.goal
  await db.update(conversations).set(set).where(eq(conversations.id, id))
  return db.query.conversations.findFirst({ where: eq(conversations.id, id) })
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

export async function getConversationsByProject(projectId: string, userId: string) {
  const rows = await db.query.conversations.findMany({
    where: (t, { and, eq: eqFn }) => and(eqFn(t.user_id, userId)),
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
