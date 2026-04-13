/**
 * Plan 22 revision — Company & Team structure prompt segment.
 *
 * Loaded fresh per run (cheap — one or two indexed DB queries) and appended to the
 * system prompt via JikuRunParams.extra_system_segments. Gives the agent cross-user
 * awareness: who is in the project, their role, and their known external identities
 * (Telegram user_id, Discord id, etc.) so "ingatkan user B" can resolve without
 * the agent having to discover everything from scratch.
 */

import {
  listProjectMembers,
  getUserIdentities,
  db,
  connector_identities,
  eq,
} from '@jiku-studio/db'

interface MemberLine {
  user_id: string
  display_name: string
  role: string
  is_superadmin: boolean
  identities: Record<string, string>
}

/**
 * Build a `[Company & Team]` system-prompt section for the given project.
 * Returns empty string when there are no members (plugin never injected).
 */
export async function buildTeamStructureSegment(projectId: string): Promise<string> {
  const members = await listProjectMembers(projectId)
  if (members.length === 0) return ''

  // Gather identities per member — two sources:
  //   1. user_identities — generic key/value (phone, email, custom)
  //   2. connector_identities — per-connector external ids (telegram user_id, etc.)
  const lines: MemberLine[] = []
  for (const m of members) {
    const userId = (m.user as { id?: string } | null)?.id ?? m.user_id
    if (!userId) continue
    const displayName =
      (m.user as { display_name?: string | null; email?: string | null } | null)?.display_name ??
      (m.user as { email?: string | null } | null)?.email ??
      userId

    const identities: Record<string, string> = {}

    // user_identities: { key → value }
    try {
      const ids = await getUserIdentities(userId, projectId)
      for (const row of ids) identities[row.key] = row.value
    } catch { /* ignore */ }

    // connector_identities: flatten external_ref_keys with connector prefix
    try {
      const rows = await db
        .select({ ext: connector_identities.external_ref_keys, connector_id: connector_identities.connector_id, status: connector_identities.status })
        .from(connector_identities)
        .where(eq(connector_identities.mapped_user_id, userId))
      for (const r of rows) {
        if (r.status !== 'approved') continue
        const ext = (r.ext ?? {}) as Record<string, string>
        for (const [k, v] of Object.entries(ext)) {
          if (!v) continue
          identities[`connector:${r.connector_id}:${k}`] = v
        }
      }
    } catch { /* ignore */ }

    lines.push({
      user_id: userId,
      display_name: displayName,
      role: (m.role as { name?: string } | null)?.name ?? 'member',
      is_superadmin: Boolean((m as Record<string, unknown>).is_superadmin),
      identities,
    })
  }

  const body: string[] = []
  body.push('[Company & Team]')
  body.push('People you may be asked to act on behalf of, or direct messages towards. Use `identity_find` / `identity_get` / `connector_list_targets` to resolve recipients before scheduling cross-user tasks.')
  body.push('')
  body.push('| display_name | user_id | role | known identities |')
  body.push('|--------------|---------|------|-------------------|')
  for (const m of lines) {
    const idSummary = Object.keys(m.identities).length > 0
      ? Object.entries(m.identities).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('; ')
      : '(none known — ask the user before delivering to them)'
    const roleTag = m.is_superadmin ? `${m.role}* (superadmin)` : m.role
    body.push(`| ${m.display_name} | ${m.user_id} | ${roleTag} | ${idSummary} |`)
  }
  body.push('')
  body.push('Rules when a task concerns another user:')
  body.push('- If identities column shows a reachable channel (e.g. telegram user_id), you can set it as the cron `subject` and plan `delivery` via that channel.')
  body.push('- If identities are empty, do NOT guess — explain to the originating user that the target has no reachable identity yet and ask for a contact, or ask the target to pair with the bot first.')
  body.push('- Treat `user_id` as the canonical key. Display names can collide.')

  return body.join('\n')
}
