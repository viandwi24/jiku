'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react'

/**
 * Detects `<active_command slug="...">...</active_command>` blocks injected by
 * the slash-command dispatcher (`apps/studio/server/src/commands/dispatcher.ts`)
 * and renders them as a collapsible accordion so the raw system-directive body
 * doesn't drown out the user's actual message.
 *
 * Streaming-aware: matches BOTH closed blocks and an opening tag without a
 * matching close (mid-stream state). The unclosed segment renders the same
 * accordion with a `streaming` indicator so the user sees the chip appear as
 * soon as the opening tag lands, rather than seeing raw XML scroll past until
 * the close arrives.
 */
type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'cmd'; slug: string | null; body: string; streaming: boolean }

const CLOSE_TAG = '</active_command>'

export function parseActiveCommandSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let pos = 0
  const openRe = /<active_command(?:\s+slug="([^"]+)")?>/g

  while (pos <= text.length) {
    openRe.lastIndex = pos
    const open = openRe.exec(text)
    if (!open) {
      if (pos < text.length) segments.push({ kind: 'text', value: text.slice(pos) })
      break
    }
    if (open.index > pos) segments.push({ kind: 'text', value: text.slice(pos, open.index) })

    const bodyStart = open.index + open[0].length

    // Greedy close: find the LAST `</active_command>` that occurs BEFORE the
    // next opening tag (or end of text if there is no next open). Lazy first-
    // match would be wrong if the body itself contains the literal close-tag
    // substring (e.g. dispatcher preamble that names the closing tag for the
    // model). Multiple separate blocks are still handled because we cap the
    // search at the next opening.
    openRe.lastIndex = bodyStart
    const nextOpen = openRe.exec(text)
    const searchEnd = nextOpen ? nextOpen.index : text.length
    const closeIdx = text.lastIndexOf(CLOSE_TAG, searchEnd - CLOSE_TAG.length)
    if (closeIdx >= bodyStart) {
      segments.push({
        kind: 'cmd',
        slug: open[1] ?? null,
        body: text.slice(bodyStart, closeIdx).trim(),
        streaming: false,
      })
      pos = closeIdx + CLOSE_TAG.length
    } else {
      segments.push({
        kind: 'cmd',
        slug: open[1] ?? null,
        body: text.slice(bodyStart).trim(),
        streaming: true,
      })
      pos = text.length + 1
    }
  }
  return segments
}

interface RenderProps {
  text: string
  isUser: boolean
}

export function MessageTextWithActiveCommands({ text, isUser }: RenderProps) {
  const segments = useMemo(() => parseActiveCommandSegments(text), [text])

  if (segments.length === 1 && segments[0]!.kind === 'text') {
    return <span className="whitespace-pre-wrap">{text}</span>
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          const trimmed = seg.value.replace(/^\n+|\n+$/g, '')
          if (!trimmed) return null
          return <span key={i} className="whitespace-pre-wrap">{trimmed}</span>
        }
        return (
          <ActiveCommandBlock
            key={i}
            slug={seg.slug}
            body={seg.body}
            isUser={isUser}
            streaming={seg.streaming}
          />
        )
      })}
    </>
  )
}

interface ActiveCommandBlockProps {
  slug: string | null
  body: string
  isUser: boolean
  streaming?: boolean
}

export function ActiveCommandBlock({ slug, body, isUser, streaming = false }: ActiveCommandBlockProps) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={cn(
        'rounded-lg border text-xs my-1 overflow-hidden',
        isUser
          ? 'border-primary-foreground/20 bg-primary-foreground/5'
          : 'border-border bg-background/60',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 text-left',
          isUser ? 'hover:bg-primary-foreground/10' : 'hover:bg-muted',
        )}
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Terminal className="w-3 h-3 shrink-0 opacity-70" />
        <span className="font-mono opacity-80">
          {slug ? `/${slug}` : 'active_command'}
        </span>
        {streaming && (
          <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            streaming
          </span>
        )}
        <span className="ml-auto opacity-60 text-[10px] uppercase tracking-wide">
          system prompt
        </span>
      </button>
      {open && (
        <pre className={cn(
          'px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap wrap-break-word border-t font-mono',
          isUser ? 'border-primary-foreground/10' : 'border-border',
        )}>
          {body}
          {streaming && <span className="text-muted-foreground/60"> …</span>}
        </pre>
      )}
    </div>
  )
}
