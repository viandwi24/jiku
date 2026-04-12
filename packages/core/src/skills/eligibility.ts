import type { SkillEligibility, SkillEligibilityContext, SkillManifest } from '@jiku/types'

/**
 * Plan 19 — Eligibility check for a skill given the runtime context.
 *
 * Skills without `metadata.jiku.requires` pass unconditionally (external skills
 * from skills.sh will not carry the extension — that's fine).
 */
export function checkSkillEligibility(
  manifest: SkillManifest,
  ctx: SkillEligibilityContext,
): SkillEligibility {
  const req = manifest.metadata?.jiku?.requires
  if (!req) return { eligible: true }

  if (req.os && req.os.length > 0 && !req.os.includes(ctx.os)) {
    return { eligible: false, reason: `os not in [${req.os.join(', ')}]` }
  }
  if (req.bins && req.bins.length > 0) {
    const missing = req.bins.find(b => !ctx.availableBins.has(b))
    if (missing) return { eligible: false, reason: `missing bin \`${missing}\`` }
  }
  if (req.env && req.env.length > 0) {
    const missing = req.env.find(e => !ctx.env[e])
    if (missing) return { eligible: false, reason: `missing env \`${missing}\`` }
  }
  if (req.permissions && req.permissions.length > 0) {
    const missing = req.permissions.find(p => !ctx.grantedPermissions.has(p))
    if (missing) return { eligible: false, reason: `missing permission \`${missing}\`` }
  }
  if (req.config && req.config.length > 0) {
    const missing = req.config.find(c => !getNestedConfig(ctx.projectConfig, c))
    if (missing) return { eligible: false, reason: `missing config \`${missing}\`` }
  }
  return { eligible: true }
}

function getNestedConfig(obj: unknown, dottedPath: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  let cur: unknown = obj
  for (const key of dottedPath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
