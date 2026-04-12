import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
import type { SkillEligibilityContext } from '@jiku/types'
import { getProjectById } from '@jiku-studio/db'

/**
 * Plan 19 — Build runtime eligibility context for a project.
 *
 * `availableBins` is probed lazily via `which`/`where` with a 5-minute TTL cache
 * per bin. Permissions come from Plan 18's plugin_granted_permissions, but since
 * skill eligibility is pre-run (not user-scoped), we treat the empty set as
 * "no granted permissions" — skills with `requires.permissions` need to be
 * assigned manually until a per-context grant flow lands.
 */

const BIN_TTL_MS = 5 * 60 * 1000
const binCache = new Map<string, { available: boolean; until: number }>()

function isBinAvailable(bin: string): boolean {
  const now = Date.now()
  const hit = binCache.get(bin)
  if (hit && hit.until > now) return hit.available

  const cmd = platform() === 'win32' ? 'where' : 'which'
  const result = spawnSync(cmd, [bin], { stdio: 'ignore' })
  const available = result.status === 0
  binCache.set(bin, { available, until: now + BIN_TTL_MS })
  return available
}

export async function buildEligibilityContext(projectId: string): Promise<SkillEligibilityContext> {
  const project = await getProjectById(projectId)
  const projectConfig = (project?.memory_config ?? {}) as unknown
  // Build a per-call wrapper so `availableBins.has(x)` resolves the probe lazily.
  const availableBins: Set<string> = new Set()
  const probedSet: Set<string> = new Set()
  // We need `has()` to probe on miss. Return a Proxy that delegates.
  const dynamicSet = new Proxy(availableBins, {
    get(target, prop, receiver) {
      if (prop === 'has') {
        return (bin: string) => {
          if (probedSet.has(bin)) return target.has(bin)
          probedSet.add(bin)
          if (isBinAvailable(bin)) target.add(bin)
          return target.has(bin)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  return {
    os: platform(),
    availableBins: dynamicSet,
    env: process.env as Record<string, string | undefined>,
    grantedPermissions: new Set<string>(),
    projectConfig,
  }
}
