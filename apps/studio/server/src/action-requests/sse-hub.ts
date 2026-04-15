import type { Response } from 'express'
import { subscribeProjectActionRequests, type ActionRequestUpdate } from './pubsub.ts'

/**
 * SSE bridge: turn a long-lived HTTP response into a subscriber to project-level
 * AR updates. Returns a teardown fn the route closes on req 'close'.
 */
export function attachProjectActionRequestStream(projectId: string, res: Response): () => void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const ping = setInterval(() => {
    try { res.write(':ping\n\n') } catch { /* connection closed */ }
  }, 15_000)

  const unsubscribe = subscribeProjectActionRequests(projectId, (update: ActionRequestUpdate) => {
    try {
      const payload = JSON.stringify(update, (_, v) => v instanceof Date ? v.toISOString() : v)
      res.write(`data: ${payload}\n\n`)
    } catch { /* connection closed */ }
  })

  return () => {
    clearInterval(ping)
    unsubscribe()
  }
}
