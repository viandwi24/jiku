import type { JikuStorageAdapter, Conversation, Message } from '@jiku/types'

export class MemoryStorageAdapter implements JikuStorageAdapter {
  private conversations = new Map<string, Conversation>()
  private messages = new Map<string, Message[]>()
  private store = new Map<string, unknown>()

  private newId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null
  }

  async createConversation(data: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>): Promise<Conversation> {
    const now = new Date()
    const conv: Conversation = { ...data, id: this.newId(), created_at: now, updated_at: now }
    this.conversations.set(conv.id, conv)
    this.messages.set(conv.id, [])
    return conv
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<Conversation> {
    const conv = this.conversations.get(id)
    if (!conv) throw new Error(`Conversation '${id}' not found`)
    const updated = { ...conv, ...updates, updated_at: new Date() }
    this.conversations.set(id, updated)
    return updated
  }

  async listConversations(agent_id: string): Promise<Conversation[]> {
    return [...this.conversations.values()].filter(c => c.agent_id === agent_id)
  }

  async getMessages(conversation_id: string, opts?: { limit?: number; offset?: number }): Promise<Message[]> {
    const msgs = this.messages.get(conversation_id) ?? []
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? msgs.length
    return msgs.slice(offset, offset + limit)
  }

  async addMessage(conversation_id: string, message: Omit<Message, 'id' | 'created_at'>): Promise<Message> {
    const msgs = this.messages.get(conversation_id) ?? []
    const msg: Message = { ...message, id: this.newId(), created_at: new Date() }
    msgs.push(msg)
    this.messages.set(conversation_id, msgs)
    return msg
  }

  async deleteMessages(conversation_id: string, ids: string[]): Promise<void> {
    const msgs = this.messages.get(conversation_id) ?? []
    this.messages.set(conversation_id, msgs.filter(m => !ids.includes(m.id)))
  }

  async replaceMessages(conversation_id: string, newMessages: Omit<Message, 'id' | 'created_at'>[]): Promise<Message[]> {
    const created = newMessages.map(m => ({ ...m, id: this.newId(), created_at: new Date() }) as Message)
    this.messages.set(conversation_id, created)
    return created
  }

  async pluginGet(scope: string, key: string): Promise<unknown> {
    return this.store.get(`${scope}:${key}`) ?? null
  }

  async pluginSet(scope: string, key: string, value: unknown): Promise<void> {
    this.store.set(`${scope}:${key}`, value)
  }

  async pluginDelete(scope: string, key: string): Promise<void> {
    this.store.delete(`${scope}:${key}`)
  }

  async pluginKeys(scope: string, prefix?: string): Promise<string[]> {
    const scopePrefix = `${scope}:`
    const keys: string[] = []
    for (const key of this.store.keys()) {
      if (key.startsWith(scopePrefix)) {
        const k = key.slice(scopePrefix.length)
        if (!prefix || k.startsWith(prefix)) keys.push(k)
      }
    }
    return keys
  }
}
