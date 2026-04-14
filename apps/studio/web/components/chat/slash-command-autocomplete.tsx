'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePromptInputController } from '@jiku/ui/components/ai-elements/prompt-input.tsx'
import { api, type CommandItem } from '@/lib/api'

/**
 * Plan 28 — Slash-command autocomplete.
 *
 * When the user types `/` as the first character of the chat input (and is
 * still typing the slug — no whitespace yet), pop a dropdown of matching
 * commands. ArrowUp / ArrowDown navigate. Tab / Enter inserts. Esc dismisses.
 *
 * Requires the parent to wrap PromptInput with <PromptInputProvider /> so this
 * component can read + set the input value through the shared controller.
 */
export function SlashCommandAutocomplete({
  agentId,
}: {
  agentId: string
}) {
  const { textInput } = usePromptInputController()
  const value = textInput.value

  const [allCommands, setAllCommands] = useState<CommandItem[]>([])
  const [allowlist, setAllowlist] = useState<CommandItem[]>([])
  const [accessMode, setAccessMode] = useState<'manual' | 'all'>('manual')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Fetch agent (project_id + command_access_mode), refresh FS sync, then
  // load commands. Respect the configured mode uniformly — same contract as
  // the backend dispatcher. `manual` = allowlist only, `all` = full project.
  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    ;(async () => {
      try {
        const { agent } = await api.agents.get(agentId)
        if (cancelled || !agent?.project_id) return
        setAccessMode((agent.command_access_mode as 'manual' | 'all' | null) ?? 'manual')
        // Trigger an FS rescan so commands the user just dropped into
        // /commands/ via the disk explorer appear without a full project reload.
        await api.commands.refresh(agent.project_id).catch(() => {})
        if (cancelled) return
        const [proj, assigned] = await Promise.all([
          api.commands.list(agent.project_id).catch(() => ({ commands: [] as CommandItem[] })),
          api.commands.listAgentCommands(agentId).catch(() => ({ assignments: [] })),
        ])
        if (cancelled) return
        setAllCommands(proj.commands.filter(c => c.active && c.enabled))
        setAllowlist(assigned.assignments.map(a => a.command).filter(c => c.active && c.enabled))
      } catch {
        if (!cancelled) { setAllCommands([]); setAllowlist([]) }
      }
    })()
    return () => { cancelled = true }
  }, [agentId])

  const baseList: CommandItem[] = accessMode === 'all' ? allCommands : allowlist

  // Parse input — trigger only when input starts with `/` and still typing slug.
  const match = useMemo(() => {
    const m = value.match(/^\/([a-zA-Z0-9_\-]*)$/)
    return m ? { filter: m[1] ?? '' } : null
  }, [value])

  const filtered = useMemo(() => {
    if (!match) return []
    const q = match.filter.toLowerCase()
    return baseList
      .filter(c => c.slug.toLowerCase().startsWith(q))
      .slice(0, 8)
  }, [match, baseList])

  const open = !!match && filtered.length > 0

  // Reset selection when filter changes.
  useEffect(() => { setSelectedIdx(0) }, [match?.filter, filtered.length])

  // Keyboard handling — capture phase so we intercept before textarea handles Enter/Tab.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx(i => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = filtered[selectedIdx]
        if (pick) {
          e.preventDefault()
          e.stopPropagation()
          textInput.setInput(`/${pick.slug} `)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        // Soft dismiss: append a space to break the match.
        textInput.setInput(value + ' ')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, selectedIdx, textInput, value])

  if (!open) return null

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-2 z-50 bg-popover border rounded-md shadow-lg overflow-hidden max-h-72 overflow-y-auto"
      role="listbox"
      aria-label="Commands"
    >
      <div className="py-1">
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground border-b">
          Commands — ↑↓ navigate · ↵ / Tab to insert · Esc to dismiss
        </div>
        {filtered.map((cmd, idx) => {
          const manifest = cmd.manifest as { metadata?: { jiku?: { emoji?: string } } } | undefined
          const emoji = manifest?.metadata?.jiku?.emoji ?? '/'
          const selected = idx === selectedIdx
          return (
            <button
              key={cmd.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={`w-full text-left px-3 py-2 text-sm flex items-start gap-2 transition-colors ${selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
              onMouseDown={e => {
                e.preventDefault()
                textInput.setInput(`/${cmd.slug} `)
              }}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span className="shrink-0 text-base leading-snug" aria-hidden>{emoji}</span>
              <span className="flex-1 min-w-0">
                <span className="block font-medium truncate">/{cmd.slug}</span>
                {cmd.description && (
                  <span className="block text-xs text-muted-foreground truncate">{cmd.description}</span>
                )}
              </span>
              {cmd.tags?.length ? (
                <span className="shrink-0 text-[10px] text-muted-foreground/80 mt-0.5">
                  {cmd.tags.slice(0, 2).join(' · ')}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
