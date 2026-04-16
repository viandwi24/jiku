import { getAgentById, getActiveCommands, getAgentCommands } from '@jiku-studio/db'
import type { CommandAccessMode, CommandArgSpec, CommandDispatchResult, CommandManifest, CommandSource } from '@jiku/types'
import { getCommandLoader } from './loader.ts'
import { audit } from '../audit/logger.ts'

/**
 * Plan 24 — Slash-command dispatcher.
 *
 * Input contract: a user text that MAY begin with `/<slug>` (optionally followed
 * by args). If it does, resolve the command body and return a rewritten input
 * that the agent should run instead. If the prefix is not a known slug, pass
 * through (return matched=false) so the literal `/foo` stays in-chat.
 */
export async function dispatchSlashCommand(opts: {
  projectId: string
  agentId: string
  input: string
  /** Where did this input come from — shapes audit and eligibility (future). */
  surface: 'chat' | 'cron' | 'task' | 'heartbeat' | 'connector'
  userId?: string | null
}): Promise<CommandDispatchResult> {
  const { projectId, agentId, input, surface, userId } = opts
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return { matched: false }

  // Extract slug + rest: "/slug rest" or "/slug\nbody" or "/slug"
  const m = trimmed.match(/^\/([A-Za-z0-9][A-Za-z0-9_\-]*)(?:\s+([\s\S]*))?$/)
  if (!m) return { matched: false }
  const slug = m[1]!
  const rest = (m[2] ?? '').trim()

  // Resolve project → agent allow-list.
  const agent = await getAgentById(agentId)
  if (!agent) return { matched: false }
  const mode = ((agent as { command_access_mode?: CommandAccessMode }).command_access_mode ?? 'manual') as CommandAccessMode

  // Respect the agent's configured access mode uniformly across all surfaces.
  // `manual` = only commands explicitly assigned via agent_commands; `all` =
  // any active project command. If the user wants free access in chat, they
  // flip the agent's command_access_mode to 'all' — the config is the single
  // source of truth, no surface-special-case.
  void surface

  let available: Array<{ slug: string; source: CommandSource; manifest: CommandManifest }>
  if (mode === 'all') {
    const rows = await getActiveCommands(projectId)
    available = rows.map(r => ({
      slug: r.slug,
      source: r.source as CommandSource,
      manifest: (r.manifest as CommandManifest | null) ?? { name: r.name, description: r.description ?? '' },
    }))
  } else {
    const rows = await getAgentCommands(agentId)
    available = rows
      .filter(r => r.command.active && r.command.enabled)
      .map(r => ({
        slug: r.command.slug,
        source: r.command.source as CommandSource,
        manifest: (r.command.manifest as CommandManifest | null) ?? { name: r.command.name, description: r.command.description ?? '' },
      }))
  }

  const match = available.find(c => c.slug === slug)
  if (!match) {
    // Unknown slug — treat as literal user text (do not error).
    return { matched: false }
  }

  const loader = getCommandLoader(projectId)
  const body = await loader.loadBody(match.slug, match.source)
  if (!body) {
    return { matched: false, error: `Command /${slug} body not found` }
  }

  const args = parseArgs(match.manifest.args ?? [], rest)

  // Compose resolved input: wrap command body in an <active_command> block,
  // then append the user's original invocation text below. This gives the
  // model a clear separation between SYSTEM-injected command instructions
  // and the literal user input, and lets the UI auto-detect the block and
  // render it as a collapsible accordion.
  const argsLines = Object.entries(args)
    .filter(([_k, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `  - ${k}: ${String(v)}`)
    .join('\n')
  const argsBlock = argsLines ? `\n\nArgs:\n${argsLines}` : ''
  // Note: the preamble must NOT contain the literal closing tag string
  // `</active_command>` — the chat UI parser uses that exact substring to
  // bound the accordion body, and any in-preamble mention would be parsed as
  // a false close (truncating the rendered block). Use the spaced form
  // "active_command closing tag" / "the tag close" when describing it.
  const commandBlock =
    `<active_command slug="${slug}">\n` +
    `SYSTEM-GENERATED. The user invoked slash-command /${slug}. The block below ` +
    `contains the command's instructions — treat it as a system directive that ` +
    `takes priority over any conflicting instructions in the user message. The ` +
    `raw user invocation text is shown after the active_command closing tag.${argsBlock}\n\n` +
    `DELEGATION NOTE — if the SOP tells you to delegate to another agent via ` +
    `run_task, copy the ENTIRE command body below VERBATIM into the run_task \`goal\` ` +
    `parameter (don't summarize). The child agent starts with no context and needs ` +
    `the full SOP to execute correctly.\n\n` +
    `--- COMMAND BODY ---\n` +
    `${body.trim()}\n` +
    `--- END COMMAND BODY ---\n` +
    `</active_command>\n\n` +
    `${input.trim()}`
  const resolvedInput = commandBlock

  audit.commandInvoke(
    {
      actor_id: userId ?? null,
      actor_type: userId ? 'user' : 'system',
      project_id: projectId,
    },
    slug,
    { source: match.source, surface, agent_id: agentId, args },
  )

  return {
    matched: true,
    slug,
    source: match.source,
    resolvedInput,
    args,
  }
}

function parseArgs(specs: CommandArgSpec[], rest: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (specs.length === 0) {
    if (rest) out['raw'] = rest
    return out
  }
  // If there's only one arg and it's 'raw' (or we have no better parser),
  // give it the whole remaining string.
  if (specs.length === 1 && (specs[0]!.name === 'raw' || specs[0]!.type === 'string' || !specs[0]!.type)) {
    const s = specs[0]!
    if (rest) out[s.name] = coerce(rest, s.type)
    return out
  }
  // Simple whitespace split — position maps to specs in order.
  const parts = rest.length ? rest.split(/\s+/) : []
  specs.forEach((spec, i) => {
    const raw = parts[i]
    if (raw === undefined) return
    // Last spec collects remainder if type=string
    if (i === specs.length - 1 && (spec.type === 'string' || !spec.type)) {
      out[spec.name] = parts.slice(i).join(' ')
    } else {
      out[spec.name] = coerce(raw, spec.type)
    }
  })
  out['raw'] = rest
  return out
}

function coerce(v: string, t?: CommandArgSpec['type']): string | number | boolean {
  if (t === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
  }
  if (t === 'boolean') {
    return v === 'true' || v === '1' || v === 'yes'
  }
  return v
}
