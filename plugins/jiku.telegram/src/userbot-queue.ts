/**
 * Plan 24 Phase 5 — Userbot rate-limit + queue management.
 *
 * MANDATORY for the MTProto userbot adapter. Telegram is significantly more
 * strict about automation patterns on USER accounts than on bot accounts:
 * cross-chat blast, rapid repeats, or "scraping bot" forwards can result in
 * PEER_FLOOD (account marked spam-restricted) within minutes — recovery takes
 * days and may require contacting Telegram support.
 *
 * The queue here is ONE non-bypassable line of defence:
 *   - Per-chat FIFO: serialize outbound per chat_id so we never race two sends
 *     to the same chat. Plus a minimum gap (default 1000ms) between consecutive
 *     sends to the same chat.
 *   - Global session sliding window: max 20 outbound API calls per minute
 *     across ALL chats. Triggers at the session level, not per-chat — even if
 *     spread across many chats, exceeding this signals "automation" to TG.
 *   - Per-action cooldown: `join_chat` / `leave_chat` capped at 10/hour
 *     (Telegram heuristic for spam scraping bots).
 *   - New-chat min gap: when this session sends to a chat for the first time,
 *     enforce a 5s minimum since the previous new-chat first-send. Mimics
 *     human behaviour of pausing before starting a fresh conversation.
 *   - `forward_message` with drop_author cooldown: 2s minimum gap per source
 *     chat (mtproto users with high forward volume from one source = banned).
 *
 * Telegram errors handled here:
 *   - FLOOD_WAIT_X: pause the affected scope (chat or session) for X seconds.
 *     Caller's request resolves with a structured error so the agent can back off.
 *   - PEER_FLOOD: latch a session-wide `spamRestricted` flag. All subsequent
 *     auto-send actions return error until the flag is manually cleared
 *     (admin acknowledges + re-runs the wizard / checks the account).
 *   - AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED: surfaced as `sessionExpired`
 *     — caller maps to credential-level "setup_required".
 *
 * Configurable per credential via `queue_policy` field; defaults below match
 * Plan §8b. Reducing the values is allowed (advanced — at the user's risk);
 * raising them is recommended for sensitive accounts. Disabling the queue
 * entirely is NOT supported by design.
 */

export interface UserbotQueuePolicy {
  /** Minimum ms between consecutive sends to the same chat. */
  min_gap_per_chat_ms: number
  /** Sliding-window cap: max global outbound calls per minute. */
  max_per_minute_global: number
  /** First-send to a brand-new chat in this session: minimum gap since last new-chat first-send. */
  new_chat_min_gap_ms: number
  /** forward_message drop_author: min gap per source chat. */
  forward_drop_author_min_gap_ms: number
  /** join_chat / leave_chat: max per hour. */
  join_leave_max_per_hour: number
}

export const DEFAULT_USERBOT_QUEUE_POLICY: UserbotQueuePolicy = {
  min_gap_per_chat_ms: 1000,
  max_per_minute_global: 20,
  new_chat_min_gap_ms: 5000,
  forward_drop_author_min_gap_ms: 2000,
  join_leave_max_per_hour: 10,
}

export interface QueueScope {
  /** Chat id for chat-level scoping. Use "_global" for session-level scope. */
  chatId: string | '_global'
  /** Action id for per-action cooldown; optional. */
  actionId?: string
}

export interface QueueDelayInfo {
  delay_ms: number
  reason: 'per_chat_gap' | 'global_quota' | 'new_chat_gap' | 'forward_cooldown' | 'join_leave_cooldown' | 'flood_wait_chat' | 'flood_wait_global'
}

export interface QueueRunResult<T> {
  result: T
  delay_ms_applied: number
  queued_at: number
  executed_at: number
}

export interface QueueStatusSnapshot {
  pending_per_chat: Record<string, number>
  global_calls_last_minute: number
  global_quota_remaining: number
  global_rate_used_percent: number
  flood_wait_active: { scope: 'chat' | 'global'; chat_id?: string; resumes_at: number } | null
  spam_restricted: boolean
  session_expired: boolean
  policy: UserbotQueuePolicy
  estimated_delay_next_ms: number
}

export interface FloodWaitEvent {
  scope: 'chat' | 'global'
  chat_id?: string
  seconds: number
  source_action: string
  occurred_at: number
}

type Hook = (event: Record<string, unknown>) => void

export class UserbotQueue {
  private policy: UserbotQueuePolicy
  private chatChains = new Map<string, Promise<unknown>>()
  private chatLastSendAt = new Map<string, number>()
  private globalCallTimestamps: number[] = []
  private newChatLastSendAt = 0
  private knownChats = new Set<string>()
  private forwardLastByChat = new Map<string, number>()
  private joinLeaveTimestamps: number[] = []
  private floodWaitChatUntil = new Map<string, number>()
  private floodWaitGlobalUntil = 0
  private spamRestricted = false
  private sessionExpired = false
  private observerHook: Hook | null = null

  constructor(policy: Partial<UserbotQueuePolicy> = {}) {
    this.policy = { ...DEFAULT_USERBOT_QUEUE_POLICY, ...policy }
  }

  setPolicy(policy: Partial<UserbotQueuePolicy>): void {
    this.policy = { ...this.policy, ...policy }
  }

  /** Subscribe to queue lifecycle events for audit logging. */
  onEvent(hook: Hook): void { this.observerHook = hook }

  /** Latch the spam-restricted flag — auto-send is refused until cleared. */
  markSpamRestricted(): void {
    this.spamRestricted = true
    this.observerHook?.({ type: 'spam_restricted' })
  }
  clearSpamRestricted(): void { this.spamRestricted = false }

  markSessionExpired(): void {
    this.sessionExpired = true
    this.observerHook?.({ type: 'session_expired' })
  }
  isSessionExpired(): boolean { return this.sessionExpired }

  isSpamRestricted(): boolean { return this.spamRestricted }

  /**
   * Wrap an outbound API call with all the rate-limit guards. Returns the
   * inner function's result on success; rejects with structured errors on
   * latched conditions (spam_restricted / session_expired) or floods bubbling
   * up from `fn`.
   */
  async enqueue<T>(scope: QueueScope, fn: () => Promise<T>, sourceAction: string): Promise<QueueRunResult<T>> {
    if (this.sessionExpired) {
      throw Object.assign(new Error('SESSION_EXPIRED — re-run the Setup wizard'), { code: 'SESSION_EXPIRED' })
    }
    if (this.spamRestricted) {
      throw Object.assign(new Error('PEER_FLOOD — session is spam-restricted; auto-send disabled'), { code: 'PEER_FLOOD_LATCHED' })
    }

    const chatKey = scope.chatId
    const queuedAt = Date.now()

    // Serialize against any pending op for the same chat.
    const previous = this.chatChains.get(chatKey) ?? Promise.resolve()
    const ownDeferred: { resolve: () => void } = { resolve: () => {} }
    const ownGate = new Promise<void>(r => { ownDeferred.resolve = r })
    this.chatChains.set(chatKey, ownGate)

    try {
      await previous

      // Compute cumulative delay required.
      const computed = this.computeDelay(scope, sourceAction)
      if (computed.delay_ms > 0) {
        this.observerHook?.({ type: 'queue_delayed', chat_id: chatKey, action: sourceAction, delay_ms: computed.delay_ms, reason: computed.reason })
        await sleep(computed.delay_ms)
      }

      // Pre-record the call BEFORE invoking — this way concurrent attempts to
      // the same chat are correctly counted.
      const executedAt = Date.now()
      this.recordCall(scope, sourceAction, executedAt)

      try {
        const result = await fn()
        return { result, delay_ms_applied: executedAt - queuedAt, queued_at: queuedAt, executed_at: executedAt }
      } catch (err) {
        // Map FLOOD_WAIT_X / PEER_FLOOD into pause + latch.
        const msg = err instanceof Error ? err.message : String(err)
        const fw = msg.match(/FLOOD_WAIT_(\d+)/)
        if (fw) {
          const seconds = Number(fw[1])
          // Heuristic: chat-scope vs session-scope. Most FLOOD_WAIT in practice
          // is per-chat for sendMessage; per-session for join/leave/etc. We
          // assume chat-scope for send-like actions, global for join/leave.
          const isGlobal = sourceAction === 'join_chat' || sourceAction === 'leave_chat' || chatKey === '_global'
          const resumesAt = Date.now() + seconds * 1000
          if (isGlobal) {
            this.floodWaitGlobalUntil = Math.max(this.floodWaitGlobalUntil, resumesAt)
          } else {
            this.floodWaitChatUntil.set(chatKey, Math.max(this.floodWaitChatUntil.get(chatKey) ?? 0, resumesAt))
          }
          const ev: FloodWaitEvent = { scope: isGlobal ? 'global' : 'chat', chat_id: isGlobal ? undefined : chatKey, seconds, source_action: sourceAction, occurred_at: Date.now() }
          this.observerHook?.({ type: 'flood_wait', ...ev })
          throw Object.assign(new Error(`FLOOD_WAIT_${seconds}`), { code: 'FLOOD_WAIT', wait_seconds: seconds, scope: isGlobal ? 'global' : 'chat' })
        }
        if (msg.includes('PEER_FLOOD')) {
          this.markSpamRestricted()
          this.observerHook?.({ type: 'peer_flood_detected', source_action: sourceAction, chat_id: chatKey })
          throw Object.assign(new Error('PEER_FLOOD'), { code: 'PEER_FLOOD' })
        }
        if (msg.includes('AUTH_KEY_UNREGISTERED') || msg.includes('AUTH_KEY_DUPLICATED')) {
          this.markSessionExpired()
          throw Object.assign(new Error(msg), { code: 'SESSION_EXPIRED' })
        }
        throw err
      }
    } finally {
      ownDeferred.resolve()
      // Only clear the chain if it's still ours (no later enqueue replaced it).
      if (this.chatChains.get(chatKey) === ownGate) this.chatChains.delete(chatKey)
    }
  }

  /** Compute total delay we must sleep BEFORE executing this call. */
  private computeDelay(scope: QueueScope, sourceAction: string): QueueDelayInfo {
    const now = Date.now()
    const candidates: QueueDelayInfo[] = []

    // FLOOD_WAIT pauses (highest-priority scope).
    if (this.floodWaitGlobalUntil > now) {
      candidates.push({ delay_ms: this.floodWaitGlobalUntil - now, reason: 'flood_wait_global' })
    }
    if (scope.chatId !== '_global') {
      const until = this.floodWaitChatUntil.get(scope.chatId) ?? 0
      if (until > now) candidates.push({ delay_ms: until - now, reason: 'flood_wait_chat' })
    }

    // Per-chat min gap.
    if (scope.chatId !== '_global') {
      const last = this.chatLastSendAt.get(scope.chatId) ?? 0
      const gap = now - last
      if (gap < this.policy.min_gap_per_chat_ms) {
        candidates.push({ delay_ms: this.policy.min_gap_per_chat_ms - gap, reason: 'per_chat_gap' })
      }
    }

    // Global sliding window. Drop timestamps older than 60s, then check count.
    this.globalCallTimestamps = this.globalCallTimestamps.filter(t => now - t < 60_000)
    if (this.globalCallTimestamps.length >= this.policy.max_per_minute_global) {
      const oldest = this.globalCallTimestamps[0]!
      const wait = 60_000 - (now - oldest)
      if (wait > 0) candidates.push({ delay_ms: wait, reason: 'global_quota' })
    }

    // New-chat first-send pacing.
    if (scope.chatId !== '_global' && !this.knownChats.has(scope.chatId)) {
      const gap = now - this.newChatLastSendAt
      if (gap < this.policy.new_chat_min_gap_ms) {
        candidates.push({ delay_ms: this.policy.new_chat_min_gap_ms - gap, reason: 'new_chat_gap' })
      }
    }

    // forward_message drop_author per-source cooldown.
    if (sourceAction === 'forward_message' && scope.chatId !== '_global') {
      const last = this.forwardLastByChat.get(scope.chatId) ?? 0
      const gap = now - last
      if (gap < this.policy.forward_drop_author_min_gap_ms) {
        candidates.push({ delay_ms: this.policy.forward_drop_author_min_gap_ms - gap, reason: 'forward_cooldown' })
      }
    }

    // join_chat / leave_chat per-hour cooldown — refuse if over cap.
    if (sourceAction === 'join_chat' || sourceAction === 'leave_chat') {
      this.joinLeaveTimestamps = this.joinLeaveTimestamps.filter(t => now - t < 60 * 60_000)
      if (this.joinLeaveTimestamps.length >= this.policy.join_leave_max_per_hour) {
        const oldest = this.joinLeaveTimestamps[0]!
        const wait = 60 * 60_000 - (now - oldest)
        if (wait > 0) candidates.push({ delay_ms: wait, reason: 'join_leave_cooldown' })
      }
    }

    if (candidates.length === 0) return { delay_ms: 0, reason: 'per_chat_gap' }
    // Pick the largest required delay (must satisfy ALL constraints).
    candidates.sort((a, b) => b.delay_ms - a.delay_ms)
    return candidates[0]!
  }

  private recordCall(scope: QueueScope, sourceAction: string, at: number): void {
    this.globalCallTimestamps.push(at)
    if (scope.chatId !== '_global') {
      this.chatLastSendAt.set(scope.chatId, at)
      if (!this.knownChats.has(scope.chatId)) {
        this.knownChats.add(scope.chatId)
        this.newChatLastSendAt = at
      }
    }
    if (sourceAction === 'forward_message' && scope.chatId !== '_global') {
      this.forwardLastByChat.set(scope.chatId, at)
    }
    if (sourceAction === 'join_chat' || sourceAction === 'leave_chat') {
      this.joinLeaveTimestamps.push(at)
    }
  }

  /** Snapshot for the `connector_get_queue_status` tool / UI health badge. */
  status(): QueueStatusSnapshot {
    const now = Date.now()
    const calls = this.globalCallTimestamps.filter(t => now - t < 60_000)
    const remaining = Math.max(0, this.policy.max_per_minute_global - calls.length)
    const used = this.policy.max_per_minute_global > 0 ? Math.round((calls.length / this.policy.max_per_minute_global) * 100) : 0

    let floodWait: QueueStatusSnapshot['flood_wait_active'] = null
    if (this.floodWaitGlobalUntil > now) {
      floodWait = { scope: 'global', resumes_at: this.floodWaitGlobalUntil }
    } else {
      for (const [chat, until] of this.floodWaitChatUntil) {
        if (until > now) { floodWait = { scope: 'chat', chat_id: chat, resumes_at: until }; break }
      }
    }

    const pendingPerChat: Record<string, number> = {}
    for (const k of this.chatChains.keys()) pendingPerChat[k] = (pendingPerChat[k] ?? 0) + 1

    // Estimate delay for the very next call to a "warm" known chat (no other constraint active).
    let estimatedNext = 0
    if (calls.length >= this.policy.max_per_minute_global) {
      const oldest = calls[0]!
      estimatedNext = Math.max(estimatedNext, 60_000 - (now - oldest))
    }
    if (floodWait) estimatedNext = Math.max(estimatedNext, floodWait.resumes_at - now)

    return {
      pending_per_chat: pendingPerChat,
      global_calls_last_minute: calls.length,
      global_quota_remaining: remaining,
      global_rate_used_percent: used,
      flood_wait_active: floodWait,
      spam_restricted: this.spamRestricted,
      session_expired: this.sessionExpired,
      policy: { ...this.policy },
      estimated_delay_next_ms: estimatedNext,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
