import { QdrantClient } from '@qdrant/js-client-rest'

const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333'

let client: QdrantClient | null = null

function getClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false })
  }
  return client
}

function collectionName(projectId: string): string {
  return `jiku_memories_${projectId.replace(/-/g, '_')}`
}

export class MemoryVectorStore {
  /** Ensure collection exists for a project. */
  async ensureCollection(projectId: string, dimensions: number): Promise<void> {
    const name = collectionName(projectId)
    try {
      await getClient().getCollection(name)
    } catch {
      await getClient().createCollection(name, {
        vectors: { size: dimensions, distance: 'Cosine' },
      })
    }
  }

  /** Upsert embedding for a memory. */
  async upsert(
    projectId: string,
    memoryId: string,
    embedding: number[],
    metadata: Record<string, string>,
  ): Promise<void> {
    const name = collectionName(projectId)
    await getClient().upsert(name, {
      points: [{
        id: memoryId,
        vector: embedding,
        payload: metadata,
      }],
    })
  }

  /** Delete point by memory ID. */
  async delete(projectId: string, memoryId: string): Promise<void> {
    const name = collectionName(projectId)
    try {
      await getClient().delete(name, { points: [memoryId] })
    } catch {
      // Ignore delete errors (point may not exist)
    }
  }

  /** Search by vector similarity. Returns memory IDs + scores. */
  async search(
    projectId: string,
    queryEmbedding: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<Array<{ id: string; score: number }>> {
    const name = collectionName(projectId)
    try {
      const results = await getClient().search(name, {
        vector: queryEmbedding,
        limit,
        filter: filter as Parameters<typeof getClient>['0'] extends QdrantClient ? never : undefined,
        with_payload: false,
      })

      return results.map(r => ({
        id: typeof r.id === 'string' ? r.id : String(r.id),
        score: r.score,
      }))
    } catch {
      // Collection may not exist yet — graceful fallback
      return []
    }
  }

  /** Check if Qdrant is reachable. */
  async isAvailable(): Promise<boolean> {
    try {
      await getClient().getCollections()
      return true
    } catch {
      return false
    }
  }
}

export const vectorStore = new MemoryVectorStore()
