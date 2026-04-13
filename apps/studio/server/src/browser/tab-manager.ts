import { execBrowserCommand } from '@jiku/browser'
import { getAllEnabledBrowserProfiles, getBrowserProfile } from '@jiku-studio/db'
import { browserMutex } from './concurrency.ts'
import { resolveCdpEndpoint } from './config.ts'
import type { JikuBrowserVercelConfig } from './adapters/jiku-browser-vercel-types.ts'

/**
 * Per-agent tab affinity tracker for the browser tool.
 *
 * Each browser PROFILE (not project — Plan 20) is a single CDP endpoint with
 * one active tab. To give each agent its own browsing state we open one tab
 * per agent per profile and `tab_switch` before every command. All commands
 * for a profile run inside the per-profile mutex (see `concurrency.ts`).
 *
 * # State model
 *
 * Each profile has a `ProfileTabState` containing an ordered list of tabs.
 *   Index 0:    "system" tab — the about:blank the container opened at
 *               startup. Owned by no agent. Used by /preview.
 *   Index 1..N: agent-owned tabs in creation order.
 */

export const DEFAULT_MAX_TABS_PER_PROFILE = 10
export const MIN_MAX_TABS = 2
export const MAX_MAX_TABS = 50

// Back-compat alias for callers written before Plan 20.
export const DEFAULT_MAX_TABS_PER_PROJECT = DEFAULT_MAX_TABS_PER_PROFILE

export const IDLE_TAB_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export interface TrackedTab {
  agentId: string | null
  lastUsedAt: number
}

interface ProfileTabState {
  tabs: TrackedTab[]
  initialized: boolean
  maxTabs: number
}

export class BrowserTabManager {
  private byProfile = new Map<string, ProfileTabState>()

  ensureInitialized(
    profileId: string,
    maxTabs: number = DEFAULT_MAX_TABS_PER_PROFILE,
  ): ProfileTabState {
    let state = this.byProfile.get(profileId)
    if (!state) {
      state = {
        tabs: [{ agentId: null, lastUsedAt: Date.now() }],
        initialized: true,
        maxTabs,
      }
      this.byProfile.set(profileId, state)
    } else if (state.maxTabs !== maxTabs) {
      state.maxTabs = maxTabs
    }
    return state
  }

  getAgentTabIndex(profileId: string, agentId: string): number | null {
    const state = this.byProfile.get(profileId)
    if (!state) return null
    const idx = state.tabs.findIndex(t => t.agentId === agentId)
    return idx >= 0 ? idx : null
  }

  appendTab(profileId: string, agentId: string): number {
    const state = this.ensureInitialized(profileId)
    state.tabs.push({ agentId, lastUsedAt: Date.now() })
    return state.tabs.length - 1
  }

  touch(profileId: string, agentId: string): void {
    const state = this.byProfile.get(profileId)
    if (!state) return
    const tab = state.tabs.find(t => t.agentId === agentId)
    if (tab) tab.lastUsedAt = Date.now()
  }

  pickEvictionCandidate(profileId: string): { index: number; agentId: string } | null {
    const state = this.byProfile.get(profileId)
    if (!state) return null
    let bestIdx = -1
    let bestTime = Number.POSITIVE_INFINITY
    for (let i = 0; i < state.tabs.length; i++) {
      const t = state.tabs[i]!
      if (t.agentId === null) continue
      if (t.lastUsedAt < bestTime) {
        bestTime = t.lastUsedAt
        bestIdx = i
      }
    }
    if (bestIdx < 0) return null
    return { index: bestIdx, agentId: state.tabs[bestIdx]!.agentId! }
  }

  isAtCapacity(profileId: string): boolean {
    const state = this.byProfile.get(profileId)
    if (!state) return false
    return state.tabs.length >= state.maxTabs
  }

  getMaxTabs(profileId: string): number | null {
    return this.byProfile.get(profileId)?.maxTabs ?? null
  }

  removeTab(profileId: string, index: number): void {
    const state = this.byProfile.get(profileId)
    if (!state) return
    if (index < 0 || index >= state.tabs.length) return
    state.tabs.splice(index, 1)
  }

  pickIdleTabs(profileId: string, now: number = Date.now()): Array<{ index: number; agentId: string }> {
    const state = this.byProfile.get(profileId)
    if (!state) return []
    const stale: Array<{ index: number; agentId: string }> = []
    for (let i = 0; i < state.tabs.length; i++) {
      const t = state.tabs[i]!
      if (t.agentId === null) continue
      if (now - t.lastUsedAt > IDLE_TAB_TIMEOUT_MS) {
        stale.push({ index: i, agentId: t.agentId })
      }
    }
    return stale.sort((a, b) => b.index - a.index)
  }

  profileIds(): string[] {
    return Array.from(this.byProfile.keys())
  }

  /** Back-compat — pre-Plan-20 callers that still think in project IDs. The
   *  new canonical name is `profileIds()`. */
  projectIds(): string[] {
    return this.profileIds()
  }

  dropProfile(profileId: string): void {
    this.byProfile.delete(profileId)
  }

  /** Back-compat alias. */
  dropProject(profileId: string): void {
    this.dropProfile(profileId)
  }

  describe(profileId: string): { totalTabs: number; agentTabs: number } | null {
    const state = this.byProfile.get(profileId)
    if (!state) return null
    const agentTabs = state.tabs.filter(t => t.agentId !== null).length
    return { totalTabs: state.tabs.length, agentTabs }
  }

  snapshot(profileId: string): ReadonlyArray<TrackedTab> {
    const state = this.byProfile.get(profileId)
    if (!state) return []
    return state.tabs.map(t => ({ ...t }))
  }
}

export const browserTabManager = new BrowserTabManager()

/**
 * Walk every known profile (both those with tracked tabs and those stored in
 * the DB) and evict agent tabs that have been idle longer than
 * `IDLE_TAB_TIMEOUT_MS`. Runs inside the per-profile mutex so it cannot race
 * with an in-flight command.
 */
export function startBrowserTabCleanup(intervalMs: number = 60_000): () => void {
  const tick = async () => {
    // Union of profiles we actively track + profiles in DB that might already
    // have tabs open. We only care about tracked ones here — untracked
    // profiles have no state to clean up.
    const trackedIds = browserTabManager.profileIds()
    if (trackedIds.length === 0) return

    // Pre-load enabled profile rows so we can resolve CDP endpoints.
    const profileRows = await getAllEnabledBrowserProfiles().catch(() => [])
    const profilesById = new Map(profileRows.map(p => [p.id, p]))

    for (const profileId of trackedIds) {
      const idleTabs = browserTabManager.pickIdleTabs(profileId)
      if (idleTabs.length === 0) continue

      // Resolve CDP endpoint via the profile row. If the profile no longer
      // exists / is disabled, drop all tracking — state would be bogus anyway.
      let cfg = profilesById.get(profileId)
      if (!cfg) cfg = (await getBrowserProfile(profileId).catch(() => null)) ?? undefined
      if (!cfg || !cfg.enabled) {
        browserTabManager.dropProfile(profileId)
        continue
      }

      let cdpEndpoint: string
      try {
        cdpEndpoint = resolveCdpEndpoint(cfg.config as JikuBrowserVercelConfig)
      } catch (err) {
        console.warn(`[browser-cleanup] failed to resolve endpoint for ${profileId}:`, err)
        continue
      }

      await browserMutex.acquire(profileId, async () => {
        const stale = browserTabManager.pickIdleTabs(profileId)
        for (const { index, agentId } of stale) {
          try {
            const r = await execBrowserCommand(cdpEndpoint, { action: 'tab', operation: 'close', index })
            if (!r.success) {
              console.warn(`[browser-cleanup] tab_close ${index} failed for ${profileId}/${agentId}: ${r.error}`)
            }
          } catch (err) {
            console.warn(`[browser-cleanup] tab_close ${index} threw for ${profileId}/${agentId}:`, err)
          }
          browserTabManager.removeTab(profileId, index)
        }
      })
    }
  }

  const handle = setInterval(() => {
    tick().catch(err => console.warn('[browser-cleanup] tick failed:', err))
  }, intervalMs)

  if (typeof handle === 'object' && handle && 'unref' in handle) {
    (handle as { unref: () => void }).unref()
  }

  return () => clearInterval(handle)
}
