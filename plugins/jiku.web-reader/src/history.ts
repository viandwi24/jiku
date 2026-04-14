// Fetch history storage. Uses ctx.storage (KV) instead of a migration — keeps
// the plugin fully self-contained. History is per-project and capped at
// HISTORY_CAP entries; oldest entries are evicted on overflow.

import type { PageMetadata } from './metadata.ts'

export interface HistoryEntry {
  id: string
  url: string
  finalUrl: string
  title: string | null
  siteName: string | null
  author: string | null
  leadImage: string | null
  excerpt: string | null
  length: number
  status: number
  fetchedAt: string
  durationMs: number
  bytes: number
  error?: string
}

export interface HistoryWriteInput {
  url: string
  finalUrl: string
  status: number
  durationMs: number
  bytes: number
  length: number
  article: { title: string | null; byline: string | null; excerpt: string | null; siteName: string | null }
  metadata: Pick<PageMetadata, 'leadImage'>
  error?: string
}

const HISTORY_CAP = 200

function key(projectId: string): string {
  return `web-reader:history:${projectId}`
}

type KV = {
  get(k: string): Promise<unknown>
  set(k: string, v: unknown): Promise<void>
  delete(k: string): Promise<void>
}

export async function listHistory(storage: KV, projectId: string): Promise<HistoryEntry[]> {
  const raw = (await storage.get(key(projectId))) as HistoryEntry[] | null
  return Array.isArray(raw) ? raw : []
}

export async function appendHistory(storage: KV, projectId: string, input: HistoryWriteInput): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    url: input.url,
    finalUrl: input.finalUrl,
    title: input.article.title,
    siteName: input.article.siteName,
    author: input.article.byline,
    leadImage: input.metadata.leadImage ?? null,
    excerpt: input.article.excerpt,
    length: input.length,
    status: input.status,
    fetchedAt: new Date().toISOString(),
    durationMs: input.durationMs,
    bytes: input.bytes,
    error: input.error,
  }
  const prev = await listHistory(storage, projectId)
  const next = [entry, ...prev].slice(0, HISTORY_CAP)
  await storage.set(key(projectId), next)
  return entry
}

export async function clearHistory(storage: KV, projectId: string): Promise<void> {
  await storage.delete(key(projectId))
}

export async function deleteHistoryEntry(storage: KV, projectId: string, id: string): Promise<void> {
  const prev = await listHistory(storage, projectId)
  const next = prev.filter(e => e.id !== id)
  await storage.set(key(projectId), next)
}
