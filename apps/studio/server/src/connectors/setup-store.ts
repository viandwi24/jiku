import { randomUUID } from 'node:crypto'
import type { ConnectorSetupSessionState } from '@jiku/types'

/**
 * Plan 24 Phase 1 — In-memory store for interactive connector setup sessions.
 *
 * Each session is keyed by a random UUID returned by `start()`. Adapter mutates
 * `state.scratch` to persist transient cross-step data (e.g. an mtcute client,
 * phone_code_hash). Sessions expire after `TTL_MS` of inactivity and on server
 * restart — user simply re-runs the wizard.
 *
 * Multi-tenancy: each session is bound to a `(project_id, credential_id)` pair.
 * Routes verify the caller has `credentials:write` on the project before
 * granting access.
 *
 * Retry cap: each step tracks `retry_count`. Wizard increments on every failed
 * attempt and aborts the session when MAX_RETRIES is reached on any one step
 * (prevents OTP-bruteforce that could lock the underlying account).
 */

const TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_RETRIES_PER_STEP = 3

export class ConnectorSetupSessionStore {
  private sessions = new Map<string, ConnectorSetupSessionState>()
  private sweepTimer: NodeJS.Timeout | null = null

  constructor() {
    // Periodic sweep — drop expired sessions every minute.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000)
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
  }

  /** Start a new setup session bound to a (project, credential) pair. */
  create(projectId: string, credentialId: string): ConnectorSetupSessionState {
    const now = Date.now()
    const state: ConnectorSetupSessionState = {
      session_id: randomUUID(),
      project_id: projectId,
      credential_id: credentialId,
      credential_fields: {},
      scratch: {},
      retry_count: 0,
      current_step_id: null,
      created_at: now,
      updated_at: now,
    }
    this.sessions.set(state.session_id, state)
    return state
  }

  /** Look up by session id. Returns null if expired or unknown. */
  get(sessionId: string): ConnectorSetupSessionState | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    if (Date.now() - s.updated_at > TTL_MS) {
      this.sessions.delete(sessionId)
      return null
    }
    return s
  }

  /** Touch — reset the TTL window without other state changes. */
  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.updated_at = Date.now()
  }

  /**
   * Set the step we're currently waiting on. Resets retry_count to 0 when
   * advancing to a new step; keeps it when re-entering the same step (so a
   * `retry_step` directive doesn't reset the counter on the failing step).
   */
  setStep(sessionId: string, stepId: string | null): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.current_step_id !== stepId) {
      s.retry_count = 0
      s.current_step_id = stepId
    }
    s.updated_at = Date.now()
  }

  /** Increment retry counter for the current step. Returns true if cap exceeded. */
  bumpRetry(sessionId: string): { count: number; capped: boolean } {
    const s = this.sessions.get(sessionId)
    if (!s) return { count: 0, capped: true }
    s.retry_count++
    s.updated_at = Date.now()
    return { count: s.retry_count, capped: s.retry_count >= MAX_RETRIES_PER_STEP }
  }

  /** Explicit teardown (cancel button, success completion). */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** For tests / introspection. */
  size(): number { return this.sessions.size }

  /** Drop sessions past TTL. */
  private sweep(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [id, s] of this.sessions) {
      if (s.updated_at < cutoff) this.sessions.delete(id)
    }
  }

  /** Stop the periodic sweep — for graceful shutdown. */
  stopSweep(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
  }
}

export const connectorSetupSessions = new ConnectorSetupSessionStore()
export const SETUP_MAX_RETRIES_PER_STEP = MAX_RETRIES_PER_STEP
