import { execBrowserCommand } from '@jiku/browser'
import { getProjectBrowserConfig } from '@jiku-studio/db'
import { browserMutex } from './concurrency.ts'
import { resolveCdpEndpoint } from './config.ts'

/**
 * Per-agent tab affinity tracker for the browser tool.
 *
 * agent-browser operates on a single "active tab" per CDP endpoint. To give
 * each agent its own browsing state (URL, cookies, refs) without spinning up
 * separate containers, we open one chromium tab per agent and `tab_switch`
 * to it before every command. This works as long as every command runs
 * inside the per-project mutex (see `concurrency.ts`) — that's the only way
 * tab indexes stay deterministic.
 *
 * # State model
 *
 * Each project has a `ProjectTabState` containing an ordered list of tabs.
 * The order MUST mirror chromium's actual tab order (which is the same as
 * the order returned by `tab_list` from agent-browser, by index).
 *
 *   Index 0:    "system" tab — the about:blank that the container opened
 *               at startup. Owned by no agent. Used by /preview.
 *   Index 1..N: agent-owned tabs in creation order.
 *
 * When this module says "open a new tab", the caller (execute.ts) is
 * responsible for actually running `tab_new` against chromium. Our state is
 * kept in sync by mutating the tabs array AFTER the chromium operation
 * succeeds. The mutex guarantees that no two operations interleave, so
 * indexes stay coherent.
 *
 * # Capacity & cleanup
 *
 * - Hard cap: `MAX_TABS_PER_PROJECT` (default 10) including the system tab.
 *   When full, the LRU agent tab (excluding system) is evicted before
 *   creating a new one.
 * - Idle eviction: `IDLE_TAB_TIMEOUT_MS` (default 10 minutes). The
 *   `evictIdleTabs()` method finds tabs older than the threshold; the caller
 *   runs `tab_close` for each and then commits the eviction via
 *   `removeTab()`.
 * - Project shutdown: `dropProject()` clears all state for a project.
 *   Caller is expected to have closed the chromium tabs already (or to
 *   accept that the next wakeUp() will see orphan tabs in chromium).
 */

export const MAX_TABS_PER_PROJECT = 10
export const IDLE_TAB_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes

/**
 * One tab as tracked by the manager. `agentId === null` means it's the
 * system tab (index 0).
 */
export interface TrackedTab {
  agentId: string | null
  lastUsedAt: number
}

interface ProjectTabState {
  tabs: TrackedTab[]
  /** True once the system tab (index 0) has been recorded. */
  initialized: boolean
}

export class BrowserTabManager {
  private byProject = new Map<string, ProjectTabState>()

  /**
   * Initialize the project's tab list with a single system tab at index 0.
   * Idempotent. Called the first time we touch a project.
   */
  ensureInitialized(projectId: string): ProjectTabState {
    let state = this.byProject.get(projectId)
    if (!state) {
      state = { tabs: [{ agentId: null, lastUsedAt: Date.now() }], initialized: true }
      this.byProject.set(projectId, state)
    }
    return state
  }

  /**
   * Look up the index of an agent's tab. Returns null if the agent has no
   * tab yet.
   */
  getAgentTabIndex(projectId: string, agentId: string): number | null {
    const state = this.byProject.get(projectId)
    if (!state) return null
    const idx = state.tabs.findIndex(t => t.agentId === agentId)
    return idx >= 0 ? idx : null
  }

  /**
   * Record that we've just opened a new chromium tab for `agentId`. The
   * caller MUST have run `tab_new` against chromium first; we assume the
   * new tab was appended at the end (chromium's default behavior).
   *
   * Returns the index of the new tab.
   */
  appendTab(projectId: string, agentId: string): number {
    const state = this.ensureInitialized(projectId)
    state.tabs.push({ agentId, lastUsedAt: Date.now() })
    return state.tabs.length - 1
  }

  /**
   * Mark an agent's tab as recently used. No-op if the agent has no tab.
   */
  touch(projectId: string, agentId: string): void {
    const state = this.byProject.get(projectId)
    if (!state) return
    const tab = state.tabs.find(t => t.agentId === agentId)
    if (tab) tab.lastUsedAt = Date.now()
  }

  /**
   * Pick a tab to evict when the project is at capacity. Returns the LRU
   * agent-owned tab, or null if only the system tab exists. Does NOT mutate
   * state — the caller closes the chromium tab and then calls `removeTab`.
   */
  pickEvictionCandidate(projectId: string): { index: number; agentId: string } | null {
    const state = this.byProject.get(projectId)
    if (!state) return null
    let bestIdx = -1
    let bestTime = Number.POSITIVE_INFINITY
    for (let i = 0; i < state.tabs.length; i++) {
      const t = state.tabs[i]!
      if (t.agentId === null) continue  // never evict system tab
      if (t.lastUsedAt < bestTime) {
        bestTime = t.lastUsedAt
        bestIdx = i
      }
    }
    if (bestIdx < 0) return null
    return { index: bestIdx, agentId: state.tabs[bestIdx]!.agentId! }
  }

  /**
   * Returns true if the project has reached the hard cap and a new agent
   * cannot get a tab without eviction.
   */
  isAtCapacity(projectId: string): boolean {
    const state = this.byProject.get(projectId)
    if (!state) return false
    return state.tabs.length >= MAX_TABS_PER_PROJECT
  }

  /**
   * Remove the tab at `index` from the manager's state. Caller MUST have
   * already run `tab_close index` against chromium (or accepted the drift).
   * Indexes after `index` shift down by 1, matching chromium's behavior.
   */
  removeTab(projectId: string, index: number): void {
    const state = this.byProject.get(projectId)
    if (!state) return
    if (index < 0 || index >= state.tabs.length) return
    state.tabs.splice(index, 1)
  }

  /**
   * Find all tabs whose `lastUsedAt` is older than the threshold. Returns
   * the slice of `{ index, agentId }` for the caller to close. Does NOT
   * mutate state.
   */
  pickIdleTabs(projectId: string, now: number = Date.now()): Array<{ index: number; agentId: string }> {
    const state = this.byProject.get(projectId)
    if (!state) return []
    const stale: Array<{ index: number; agentId: string }> = []
    for (let i = 0; i < state.tabs.length; i++) {
      const t = state.tabs[i]!
      if (t.agentId === null) continue
      if (now - t.lastUsedAt > IDLE_TAB_TIMEOUT_MS) {
        stale.push({ index: i, agentId: t.agentId })
      }
    }
    // Important: return in DESCENDING index order so the caller can splice
    // safely without re-indexing.
    return stale.sort((a, b) => b.index - a.index)
  }

  /** All projects with at least one tracked tab. */
  projectIds(): string[] {
    return Array.from(this.byProject.keys())
  }

  /**
   * Drop all state for a project. Used by `runtimeManager.sleep(projectId)`
   * — at that point the runtime is going away so we don't bother closing
   * chromium tabs (the next wakeUp will start from fresh state anyway).
   */
  dropProject(projectId: string): void {
    this.byProject.delete(projectId)
  }

  /** Snapshot of tab counts per project — for debugging / monitoring. */
  describe(projectId: string): { totalTabs: number; agentTabs: number } | null {
    const state = this.byProject.get(projectId)
    if (!state) return null
    const agentTabs = state.tabs.filter(t => t.agentId !== null).length
    return { totalTabs: state.tabs.length, agentTabs }
  }

  /**
   * Read-only snapshot of tracked tabs for a project. Used by the diagnostics
   * endpoint that powers the settings page debug panel. Returns an empty
   * array if the project has no tracked state yet.
   */
  snapshot(projectId: string): ReadonlyArray<TrackedTab> {
    const state = this.byProject.get(projectId)
    if (!state) return []
    // Defensive copy so callers cannot mutate our internal state.
    return state.tabs.map(t => ({ ...t }))
  }
}

/** Singleton shared by execute.ts and the cleanup interval. */
export const browserTabManager = new BrowserTabManager()

/**
 * Walk every project tracked by the tab manager and close any agent tab
 * that has been idle longer than `IDLE_TAB_TIMEOUT_MS`. Each closure runs
 * inside the per-project mutex so it cannot race with an in-flight agent
 * command.
 *
 * This is best-effort: errors closing tabs in chromium are logged and
 * swallowed. The next time an agent reaches for a stale tab, the manager
 * will recover by re-creating it.
 *
 * Lives here so the tab-manager module owns its own lifecycle and the
 * server bootstrap only has to call `startBrowserTabCleanup()`.
 */
export function startBrowserTabCleanup(intervalMs: number = 60_000): () => void {
  const tick = async () => {
    for (const projectId of browserTabManager.projectIds()) {
      const idleTabs = browserTabManager.pickIdleTabs(projectId)
      if (idleTabs.length === 0) continue

      // Resolve CDP endpoint once per project — config rarely changes between ticks.
      let cdpEndpoint: string
      try {
        const cfg = await getProjectBrowserConfig(projectId)
        if (!cfg.enabled) {
          // Feature was disabled while tabs were tracked — drop everything.
          browserTabManager.dropProject(projectId)
          continue
        }
        cdpEndpoint = resolveCdpEndpoint(cfg.config)
      } catch (err) {
        console.warn(`[browser-cleanup] failed to resolve config for ${projectId}:`, err)
        continue
      }

      await browserMutex.acquire(projectId, async () => {
        // Re-pick inside the mutex in case the state moved while we waited.
        const stale = browserTabManager.pickIdleTabs(projectId)
        for (const { index, agentId } of stale) {
          try {
            const r = await execBrowserCommand(cdpEndpoint, { action: 'tab', operation: 'close', index })
            if (!r.success) {
              console.warn(`[browser-cleanup] tab_close ${index} failed for ${projectId}/${agentId}: ${r.error}`)
            }
          } catch (err) {
            console.warn(`[browser-cleanup] tab_close ${index} threw for ${projectId}/${agentId}:`, err)
          }
          // Whether or not chromium reported success, drop the slot — the
          // tracked index is no longer trustworthy.
          browserTabManager.removeTab(projectId, index)
        }
      })
    }
  }

  const handle = setInterval(() => {
    tick().catch(err => console.warn('[browser-cleanup] tick failed:', err))
  }, intervalMs)

  // Don't pin the event loop just for cleanup — Node will exit cleanly.
  if (typeof handle === 'object' && handle && 'unref' in handle) {
    (handle as { unref: () => void }).unref()
  }

  return () => clearInterval(handle)
}
