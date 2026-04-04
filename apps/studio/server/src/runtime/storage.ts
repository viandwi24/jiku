import {
  getConversationById,
  getMessages,
  addMessage,
  createConversation,
  updateConversationTitle,
} from '@jiku-studio/db'

export interface StorageMessage {
  role: string
  content: unknown
}

export interface ConversationRecord {
  id: string
  agent_id: string
  user_id: string
  mode: string
  title: string | null
  status: string
}

export class StudioStorageAdapter {
  constructor(private readonly projectId: string) {}

  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    const conv = await getConversationById(conversationId)
    return conv ?? null
  }

  async createConversation(agentId: string, userId: string, mode = 'chat'): Promise<ConversationRecord> {
    return createConversation({ agent_id: agentId, user_id: userId, mode })
  }

  async getMessages(conversationId: string): Promise<StorageMessage[]> {
    const msgs = await getMessages(conversationId)
    return msgs.map(m => ({ role: m.role, content: m.content }))
  }

  async addMessage(conversationId: string, role: string, content: unknown): Promise<void> {
    await addMessage({ conversation_id: conversationId, role, content })
  }

  async setTitle(conversationId: string, title: string): Promise<void> {
    await updateConversationTitle(conversationId, title)
  }
}
