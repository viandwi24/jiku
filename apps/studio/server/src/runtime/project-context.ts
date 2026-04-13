/**
 * Plan 22 revision — Project Context system-prompt segment.
 *
 * Surfaces the project default timezone + current UTC time. Critical for cron
 * scheduling: when a user says "jam 18", the agent must convert to UTC using
 * this fallback unless the user gave an explicit zone.
 */

import { getProjectById } from '@jiku-studio/db'

export async function buildProjectContextSegment(projectId: string): Promise<string> {
  const project = await getProjectById(projectId)
  if (!project) return ''

  const tz = (project as { default_timezone?: string }).default_timezone || 'UTC'
  const nowUtc = new Date()

  // Compute UTC offset for the project tz (just for human-readable hint).
  let offsetHint = ''
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    const parts = fmt.formatToParts(nowUtc)
    const offset = parts.find(p => p.type === 'timeZoneName')?.value
    if (offset) offsetHint = ` (${offset})`
  } catch { /* invalid tz — ignore */ }

  let localTimeStr = ''
  try {
    localTimeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(nowUtc)
  } catch { /* ignore */ }

  return [
    '[Project Context]',
    `Project: ${project.name}`,
    `Default timezone: ${tz}${offsetHint}`,
    `Current UTC time: ${nowUtc.toISOString()}`,
    localTimeStr ? `Current local time: ${localTimeStr}` : '',
    '',
    'Time interpretation rules:',
    `- When the user mentions a clock time without specifying a timezone (e.g. "jam 18.00", "5pm"), interpret it as the project default timezone above (${tz}).`,
    '- When the user explicitly says a different timezone ("jam 5 PST"), respect that.',
    '- DB timestamps and cron expressions are ALWAYS UTC. When you write a cron_expression, convert from the user-stated local time to UTC first.',
    `- Example: user says "jam 18 ${tz === 'UTC' ? 'UTC' : 'lokal'}" → if ${tz} = Asia/Jakarta (UTC+7), cron_expression is "0 11 * * *" (18 - 7 = 11 UTC).`,
  ].filter(Boolean).join('\n')
}
