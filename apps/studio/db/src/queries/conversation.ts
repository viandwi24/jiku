import { eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { conversations, messages } from '../schema/index.ts'
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
