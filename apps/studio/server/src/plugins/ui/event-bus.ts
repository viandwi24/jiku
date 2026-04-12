// Plan 17 — per-plugin × per-project event bus for SSE delivery.
// In-memory only; scoped so events never leak across projects.

import type { Response } from 'express'

interface Subscriber {
  pluginId: string
  projectId: string
  res: Response
}

const subs = new Set<Subscriber>()

export interface PluginEvent {
  pluginId: string
  projectId: string
  topic: string
  payload?: unknown
}

export function subscribe(sub: Subscriber): () => void {
  subs.add(sub)
  return () => { subs.delete(sub) }
}

export function publish(event: PluginEvent): void {
  const payload = JSON.stringify({ topic: event.topic, payload: event.payload })
  for (const s of subs) {
    if (s.pluginId === event.pluginId && s.projectId === event.projectId) {
      try {
        s.res.write(`data: ${payload}\n\n`)
      } catch {
        // client dropped — ignore; subscriber cleanup happens via 'close' handler
      }
    }
  }
}
