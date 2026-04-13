import type { Response } from 'express'

/**
 * Project-level SSE hub for connector events + messages.
 *
 * Subscribers register with a project_id and an optional filter object
 * (connector_id / event_type / status / direction). Emitters call broadcast*
 * after a DB log succeeds so the row is live-pushed to matching subscribers.
 */

export interface EventSseFilter {
  connector_id?: string
  event_type?: string
  direction?: string
  status?: string
}

export interface MessageSseFilter {
  connector_id?: string
  direction?: string
  status?: string
}

interface EventSubscriber {
  res: Response
  filter: EventSseFilter
}

interface MessageSubscriber {
  res: Response
  filter: MessageSseFilter
}

const eventSubs = new Map<string, Set<EventSubscriber>>()
const messageSubs = new Map<string, Set<MessageSubscriber>>()

export function subscribeProjectEvents(projectId: string, sub: EventSubscriber) {
  const set = eventSubs.get(projectId) ?? new Set()
  set.add(sub)
  eventSubs.set(projectId, set)
  return () => set.delete(sub)
}

export function subscribeProjectMessages(projectId: string, sub: MessageSubscriber) {
  const set = messageSubs.get(projectId) ?? new Set()
  set.add(sub)
  messageSubs.set(projectId, set)
  return () => set.delete(sub)
}

function matchEvent(filter: EventSseFilter, row: Record<string, unknown>): boolean {
  if (filter.connector_id && filter.connector_id !== row['connector_id']) return false
  if (filter.event_type && filter.event_type !== row['event_type']) return false
  if (filter.direction && filter.direction !== row['direction']) return false
  if (filter.status && filter.status !== row['status']) return false
  return true
}

function matchMessage(filter: MessageSseFilter, row: Record<string, unknown>): boolean {
  if (filter.connector_id && filter.connector_id !== row['connector_id']) return false
  if (filter.direction && filter.direction !== row['direction']) return false
  if (filter.status && filter.status !== row['status']) return false
  return true
}

export function broadcastProjectEvent(projectId: string, row: Record<string, unknown>) {
  const set = eventSubs.get(projectId)
  if (!set || set.size === 0) return
  const data = JSON.stringify(row, (_, v) => v instanceof Date ? v.toISOString() : v)
  for (const sub of set) {
    if (matchEvent(sub.filter, row)) {
      try { sub.res.write(`data: ${data}\n\n`) } catch { /* ignore */ }
    }
  }
}

export function broadcastProjectMessage(projectId: string, row: Record<string, unknown>) {
  const set = messageSubs.get(projectId)
  if (!set || set.size === 0) return
  const data = JSON.stringify(row, (_, v) => v instanceof Date ? v.toISOString() : v)
  for (const sub of set) {
    if (matchMessage(sub.filter, row)) {
      try { sub.res.write(`data: ${data}\n\n`) } catch { /* ignore */ }
    }
  }
}
