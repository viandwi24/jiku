/**
 * Plan 25 — In-process pub/sub for Action Request state transitions.
 *
 * SSE hub subscribes to `project:{pid}` for the operator UI. Single-process
 * EventEmitter is the existing pattern in this codebase (see connectors/sse-hub).
 */
import { EventEmitter } from 'node:events'
import type { ActionRequest } from '@jiku/types'

const bus = new EventEmitter()
bus.setMaxListeners(0)

function projectChannel(pid: string): string {
  return `project:${pid}:ar`
}

export interface ActionRequestUpdate {
  action_request: ActionRequest
  /** What changed: created, status:<new>, dropped, expired, executed, execution_failed. */
  event: string
}

export function publishActionRequestUpdate(update: ActionRequestUpdate): void {
  bus.emit(projectChannel(update.action_request.project_id), update)
}

/** Subscribe to all AR updates within a project (UI / SSE). */
export function subscribeProjectActionRequests(projectId: string, listener: (u: ActionRequestUpdate) => void): () => void {
  const ch = projectChannel(projectId)
  bus.on(ch, listener)
  return () => bus.off(ch, listener)
}
