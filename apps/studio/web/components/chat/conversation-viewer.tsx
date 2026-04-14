'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { isToolUIPart, isTextUIPart, isStaticToolUIPart, getToolName } from 'ai'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { dbPartsToUIParts } from '@/lib/messages'
import { getToken } from '@/lib/auth'
import { useConversationObserver } from '@/hooks/use-conversation-observer'
import { useLiveConversation } from '@/hooks/use-live-conversation'
import { Badge, Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@jiku/ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@jiku/ui/components/ai-elements/conversation.tsx'
import { Message, MessageContent, MessageResponse } from '@jiku/ui/components/ai-elements/message.tsx'
import { PromptInput, PromptInputButton, PromptInputFooter, PromptInputHeader, PromptInputProvider, PromptInputSubmit, PromptInputTextarea, usePromptInputAttachments } from '@jiku/ui/components/ai-elements/prompt-input.tsx'
import { SlashCommandAutocomplete } from './slash-command-autocomplete'
import { Attachments, Attachment, AttachmentPreview, AttachmentInfo, AttachmentRemove } from '@jiku/ui/components/ai-elements/attachments.tsx'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@jiku/ui/components/ai-elements/tool.tsx'
import { ArrowDown, ArrowUp, Bot, Check, Copy, Paperclip, Pencil, RefreshCw } from 'lucide-react'
import { BranchNavigator } from './branch-navigator'
import { MessageEditInput } from './message-edit-input'
import { ImageGallery, ImageGalleryTrigger } from '@/components/ui/image-gallery'
import type { GalleryImage } from '@/components/ui/image-gallery'
import { buildPricingMap, estimateCost, formatTokens } from '@/lib/usage'
import { ContextBar } from './context-bar'
import { CompactionIndicator } from './compaction-indicator'
import { MemoryPreviewSheet } from './memory-preview-sheet'

function useCopyText() {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return { copied, copy }
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const { copied, copy } = useCopyText()
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      title="Copy"
      className={`flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors ${className ?? ''}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const API_BASE = API_URL

interface CompactionEvent {
  summary: string
  removed_count: number
  token_saved: number
}

export interface ConversationViewerProps {
  convId: string
  /**
   * edit — full chat UI with input bar (default for chat page)
   * readonly — messages + context bar, no input bar (for run detail)
   */
  mode: 'edit' | 'readonly'
  conversation: {
    agent: { id: string; name: string }
    title?: string | null
    status: string
  } | null
  initialMessages: UIMessage[]
  /** Required in edit mode for file attachment uploads */
  projectId?: string
}

function AttachFileButton() {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton onClick={() => attachments.openFileDialog()} title="Attach file">
      <Paperclip className="size-4" />
    </PromptInputButton>
  )
}

function AttachmentPreviews() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map(f => (
          <Attachment key={f.id} data={f} onRemove={() => attachments.remove(f.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  )
}

function resolveAttachmentUrl(url: string): string {
  if (url.startsWith('attachment://')) {
    const id = url.slice('attachment://'.length)
    const token = getToken() ?? ''
    return `${API_BASE}/api/attachments/${id}/inline?token=${encodeURIComponent(token)}`
  }
  return url
}

function FileAttachment({ url, filename }: { url: string; mediaType?: string; filename?: string }) {
  const resolved = resolveAttachmentUrl(url)
  return (
    <a
      href={resolved}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
    >
      📎 {filename ?? 'attachment'}
    </a>
  )
}

function MessageParts({ msg }: { msg: UIMessage }) {
  if (
    msg.role === 'assistant' &&
    msg.parts.some(p => p.type === 'text' && (p as { type: 'text'; text: string }).text.startsWith('[Context Summary]'))
  ) {
    const part = msg.parts.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined
    return (
      <CompactionIndicator
        summary={part?.text.replace('[Context Summary]\n', '') ?? ''}
        removedCount={0}
        tokenSaved={0}
      />
    )
  }

  // Collect images for gallery
  const imageParts = msg.parts
    .filter(p => p.type === 'file' && (p as { type: 'file'; mediaType?: string }).mediaType?.startsWith('image/'))
    .map(p => {
      const fp = p as { type: 'file'; url: string; mediaType?: string; filename?: string }
      return { src: resolveAttachmentUrl(fp.url), alt: fp.filename, filename: fp.filename } satisfies GalleryImage
    })

  return (
    <>
      {/* Image gallery strip — shown above text for user messages */}
      {imageParts.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {imageParts.map((img, idx) => (
            <ImageGalleryTrigger key={idx} images={imageParts} index={idx}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.src}
                alt={img.alt ?? ''}
                className="max-w-50 max-h-40 rounded-lg object-cover border border-white/10"
              />
            </ImageGalleryTrigger>
          ))}
        </div>
      )}

      {msg.parts.map((part, i) => {
        if (part.type === 'file') {
          const p = part as { type: 'file'; url: string; mediaType?: string; filename?: string }
          // Images are already shown in the gallery strip above
          if (p.mediaType?.startsWith('image/')) return null
          return <FileAttachment key={i} url={p.url} mediaType={p.mediaType} filename={p.filename} />
        }
        if (isTextUIPart(part)) {
          return msg.role === 'assistant'
            ? <MessageResponse key={i}>{part.text}</MessageResponse>
            : <span key={i} className="whitespace-pre-wrap">{part.text}</span>
        }
        if (isToolUIPart(part)) {
          const toolName = getToolName(part)
          const token = getToken()
          return (
            <div key={i}>
              <Tool>
                {isStaticToolUIPart(part) ? (
                  <ToolHeader type={part.type} state={part.state} />
                ) : (
                  <ToolHeader type={part.type} state={part.state} toolName={toolName} />
                )}
                <ToolContent>
                  {'input' in part && part.input !== undefined && (
                    <ToolInput input={part.input} />
                  )}
                  {'output' in part && (
                    <ToolOutput output={part.output} errorText={part.errorText} token={token ?? undefined} />
                  )}
                </ToolContent>
              </Tool>
            </div>
          )
        }
        return null
      })}
    </>
  )
}

function ConversationTitleEdit({ convId, title, agentName }: { convId: string; title: string | null | undefined; agentName: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const { mutate: rename } = useMutation({
    mutationFn: (newTitle: string) => api.conversations.rename(convId, newTitle),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['conversation', convId] })
    },
  })

  const startEdit = () => {
    setDraft(title ?? agentName)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== (title ?? agentName)) {
      rename(trimmed)
    }
    setEditing(false)
  }

  const cancel = () => setEditing(false)

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        maxLength={50}
        className="font-semibold text-sm bg-transparent border-b border-primary outline-none w-full max-w-65"
        autoFocus
      />
    )
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="group flex items-center gap-1.5 text-left"
      title="Click to rename"
    >
      <span className="font-semibold text-sm truncate max-w-65">
        {title ?? agentName}
      </span>
      <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
    </button>
  )
}

interface BranchMeta {
  parent_message_id: string | null
  branch_index: number
  sibling_count: number
  sibling_ids: string[]
  current_sibling_index: number
}

export function ConversationViewer({ convId, mode, conversation, initialMessages, projectId }: ConversationViewerProps) {
  const [compactionEvents, setCompactionEvents] = useState<CompactionEvent[]>([])
  const [memorySheetOpen, setMemorySheetOpen] = useState(false)
  const [showUsageTip, setShowUsageTip] = useState(false)
  // Plan 23 — branch state
  const [activeTip, setActiveTip] = useState<string | null>(null)
  const [branchMeta, setBranchMeta] = useState<Map<string, BranchMeta>>(new Map())
  const [editingId, setEditingId] = useState<string | null>(null)
  // Ref mirror so the transport callback (which captures the initial closure)
  // always reads the latest active tip without rebuilding the transport.
  const activeTipRef = useRef<string | null>(null)
  useEffect(() => { activeTipRef.current = activeTip }, [activeTip])
  const qc = useQueryClient()

  const agentId = conversation?.agent.id ?? ''

  const { data: usageData } = useQuery({
    queryKey: ['usage', agentId, 'latest'],
    queryFn: () => api.agents.usage(agentId, { limit: 1 }),
    enabled: !!agentId,
    staleTime: 0,
  })
  const lastUsage = usageData?.logs[0] ?? null

  const { data: adaptersData } = useQuery({
    queryKey: ['adapters', 'provider-model'],
    queryFn: () => api.credentials.adapters('provider-model'),
    staleTime: 60_000,
  })
  const pricingMap = useMemo(() => buildPricingMap(adaptersData?.adapters ?? []), [adaptersData])

  // ── edit mode: full useChat with send capability ──────────────────────────
  const { messages, sendMessage, status, error, setMessages } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: `${API_URL}/api/conversations/${convId}/chat`,
      headers: () => ({
        Authorization: `Bearer ${getToken() ?? ''}`,
      }),
      prepareSendMessagesRequest: ({ id, messages }) => {
        // Only send the last user message — server loads history from DB.
        const lastUser = [...messages].reverse().find(m => m.role === 'user')
        return {
          body: {
            id,
            messages: lastUser ? [lastUser] : [],
            // Plan 23 — tell the server which branch tip to hang the new
            // message off. Null falls back to server-side active_tip.
            parent_message_id: activeTipRef.current,
          },
        }
      },
    }),
  })

  // Sync messages when initialMessages changes (e.g. navigating back to same conversation)
  // useChat only reads `messages` prop at mount — this effect handles post-mount updates
  useEffect(() => {
    if (initialMessages.length > 0 && messages.length === 0 && status === 'ready') {
      setMessages(initialMessages)
    }
  }, [initialMessages, messages.length, status])

  const isStreaming = status === 'streaming' || status === 'submitted'

  // Plan 23 — hydrate branch metadata from a /messages response.
  const hydrateBranchMeta = useCallback((payload: {
    active_tip_message_id?: string | null
    messages: Array<{
      id: string
      parent_message_id?: string | null
      branch_index?: number
      sibling_count?: number
      sibling_ids?: string[]
      current_sibling_index?: number
    }>
  }) => {
    setActiveTip(payload.active_tip_message_id ?? null)
    const map = new Map<string, BranchMeta>()
    for (const m of payload.messages) {
      if (typeof m.sibling_count !== 'number') continue
      map.set(m.id, {
        parent_message_id: m.parent_message_id ?? null,
        branch_index: m.branch_index ?? 0,
        sibling_count: m.sibling_count,
        sibling_ids: m.sibling_ids ?? [m.id],
        current_sibling_index: m.current_sibling_index ?? 0,
      })
    }
    setBranchMeta(map)
  }, [])

  // Fetch fresh messages + hydrate both UI messages & branch meta.
  //
  // IMPORTANT: DB stores tool parts as `{ type: 'tool-invocation', args, result, state: 'result' }`,
  // but AI SDK v6's renderer (`isToolUIPart`, `ToolInput`, `ToolOutput`) expects
  // `{ type: 'dynamic-tool', input, output, state: 'output-available' }`. Without
  // `dbPartsToUIParts` conversion the tool accordions render blank after the
  // post-stream refresh — the part shape matches `isToolUIPart` (starts with
  // `tool-`) but `input`/`output` are undefined because DB uses `args`/`result`.
  const refreshMessages = useCallback(async () => {
    const fresh = await api.conversations.messages(convId)
    hydrateBranchMeta(fresh)
    const converted = fresh.messages.map(m => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      parts: dbPartsToUIParts(m.parts as unknown[]),
      metadata: {},
    }))
    // TEMP debug — verify conversion is active and what part shapes are produced.
    // Look for part.type: should be 'dynamic-tool' (good) or 'tool-invocation' (bug, conversion didn't run).
    if (typeof window !== 'undefined') {
      console.log('[refreshMessages] converted parts sample:',
        converted
          .filter(m => m.role === 'assistant')
          .map(m => ({ id: m.id, partTypes: (m.parts as Array<{ type: string }>).map(p => p.type) }))
      )
    }
    setMessages(converted)
  }, [convId, hydrateBranchMeta, setMessages])

  // Hydrate ONLY branch meta + active tip (don't touch the UI messages array).
  // Used on mount where touching messages would race with useChat's optimistic
  // send from the pending_message handler — that race makes the user's just-
  // typed message disappear behind a thinking indicator until the response
  // finishes.
  const hydrateBranchMetaOnly = useCallback(async () => {
    try {
      const fresh = await api.conversations.messages(convId)
      hydrateBranchMeta(fresh)
    } catch { /* ignore */ }
  }, [convId, hydrateBranchMeta])

  useEffect(() => {
    hydrateBranchMetaOnly()
  }, [convId, hydrateBranchMetaOnly])

  // Plan 23 — switch to the sibling branch whose root is `siblingId`.
  const switchBranch = useCallback(async (siblingId: string) => {
    if (isStreaming) return
    try {
      const { tip_message_id } = await api.conversations.resolveSiblingTip(convId, siblingId)
      const resp = await api.conversations.setActiveTip(convId, tip_message_id)
      hydrateBranchMeta({
        active_tip_message_id: resp.active_tip_message_id,
        messages: resp.messages as Parameters<typeof hydrateBranchMeta>[0]['messages'],
      })
      const msgs = resp.messages as Array<{
        id: string; role: string; parts: unknown; created_at: string | null
      }>
      setMessages(msgs.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        parts: dbPartsToUIParts(m.parts as unknown[]),
        metadata: {},
      })))
    } catch (err) {
      console.error('[chat] switchBranch failed:', err)
    }
  }, [convId, isStreaming, hydrateBranchMeta, setMessages])

  // Plan 23 — submit an edit: create a new user message branched off the
  // parent of the edited one, then let the model run.
  const submitEdit = useCallback(async (messageId: string, newText: string) => {
    if (isStreaming) return
    let meta = branchMeta.get(messageId)
    // If the user just sent a turn before clicking edit, branchMeta may not
    // yet contain the edited message. Refetch and look it up before sending —
    // if we ship without a parent the server's null-vs-undefined fallback
    // would silently degrade the edit into a linear append.
    if (!meta) {
      try {
        const fresh = await api.conversations.messages(convId)
        const found = fresh.messages.find(m => m.id === messageId)
        if (found && typeof found.sibling_count === 'number') {
          meta = {
            parent_message_id: found.parent_message_id ?? null,
            branch_index: found.branch_index ?? 0,
            sibling_count: found.sibling_count,
            sibling_ids: found.sibling_ids ?? [found.id],
            current_sibling_index: found.current_sibling_index ?? 0,
          }
          // Hydrate state for any subsequent UI ops in this turn.
          hydrateBranchMeta(fresh)
        }
      } catch {
        // fall through — we'll still attempt the edit, just without a parent
      }
    }
    if (!meta) {
      console.error('[chat] cannot edit: branch metadata missing for', messageId)
      return
    }
    const parent = meta.parent_message_id ?? null
    setActiveTip(parent)
    activeTipRef.current = parent
    setEditingId(null)
    // Optimistically drop the edited message and everything after it so the UI
    // looks branched immediately. Without this the new message + streaming
    // response visually append below the old turn until the post-stream
    // refresh swaps in the canonical active path.
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === messageId)
      return idx >= 0 ? prev.slice(0, idx) : prev
    })
    sendMessage({ text: newText })
  }, [branchMeta, convId, hydrateBranchMeta, isStreaming, sendMessage, setMessages])

  // ── live-parts polling (used by readonly observers AND by edit-mode
  // regenerate, which streams via the connection-less /live-parts buffer
  // because it doesn't go through useChat). Declared here so `regenerate`
  // below can call `startLive` / `stopLive`.
  const { liveMessage, isStreaming: liveStreaming, start: startLive, stop: stopLive } = useLiveConversation({
    conversationId: convId,
    autoDetect: mode === 'readonly',
    onDone: async () => {
      await refreshMessages()
      qc.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  // Plan 23 — regenerate an assistant message. Hits the dedicated endpoint
  // which sets the active tip to the preceding user message, runs the model,
  // and streams back as a new assistant sibling. We start live-parts polling
  // immediately so the UI streams the new response in real time instead of
  // silently working in the background.
  const regenerate = useCallback(async (assistantMessageId: string) => {
    if (isStreaming || liveStreaming) return
    const meta = branchMeta.get(assistantMessageId)
    const userMsgId = meta?.parent_message_id
    if (!userMsgId) return
    // Optimistically drop the old assistant message so the user sees the
    // thinking indicator + streaming reply land in the same slot.
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === assistantMessageId)
      return idx >= 0 ? prev.slice(0, idx) : prev
    })
    // Start live-parts polling BEFORE firing the request so the very first
    // chunks are caught.
    startLive()
    try {
      const res = await api.conversations.regenerate(convId, userMsgId)
      if (!res.ok) {
        stopLive()
        const text = await res.text().catch(() => '')
        throw new Error(`regenerate failed: ${res.status} ${text}`)
      }
      // Drain the response body so the SSE stream actually flows on the
      // server (fetch leaves it unread otherwise → backpressure stalls
      // writes). We render from useLiveConversation, not from this body.
      ;(async () => {
        try {
          const reader = res.body?.getReader()
          if (reader) {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { done } = await reader.read()
              if (done) break
            }
          }
        } catch { /* ignore */ }
        // useLiveConversation's onDone (wired below) will refresh the path
        // when polling sees `running: false`.
      })()
    } catch (err) {
      stopLive()
      console.error('[chat] regenerate failed:', err)
    }
  }, [branchMeta, convId, isStreaming, liveStreaming, setMessages, startLive, stopLive])

  // Detect jiku-compact data parts in assistant messages
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || lastMsg.role !== 'assistant') return
    for (const part of lastMsg.parts) {
      if (part.type === 'data-jiku-compact') {
        const d = (part as { type: string; data: CompactionEvent }).data
        setCompactionEvents(prev => {
          const key = `${d.removed_count}:${d.token_saved}`
          if (prev.some(e => `${e.removed_count}:${e.token_saved}` === key)) return prev
          return [...prev, d]
        })
      }
    }
  }, [messages])

  // Observer: attach as SSE observer if already running (edit mode)
  const { attach } = useConversationObserver({
    conversationId: convId,
    onDone: async () => {
      await refreshMessages()
      qc.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  useEffect(() => {
    api.conversations.status(convId).then(({ running }) => {
      if (!running) return
      if (mode === 'edit') {
        attach()
      } else {
        startLive()
      }
    }).catch(() => { /* ignore */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, mode])

  // Cleanup live polling when unmounting in readonly mode
  useEffect(() => {
    return () => {
      if (mode === 'readonly') stopLive()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  // In edit mode: check for pending message + files from session storage
  useEffect(() => {
    if (mode !== 'edit') return
    const pendingText = sessionStorage.getItem('pending_message')
    const pendingFilesRaw = sessionStorage.getItem('pending_files')
    sessionStorage.removeItem('pending_message')
    sessionStorage.removeItem('pending_files')

    if (!pendingText && !pendingFilesRaw) return

    let fileParts: { type: 'file'; mediaType: string; url: string; filename?: string }[] = []
    if (pendingFilesRaw) {
      try {
        const parsed = JSON.parse(pendingFilesRaw) as string[]
        fileParts = parsed.map(s => {
          const { attachment_id, mediaType, filename } = JSON.parse(s) as { attachment_id: string; mediaType: string; filename?: string }
          return { type: 'file' as const, mediaType, url: `attachment://${attachment_id}`, filename }
        })
      } catch { /* ignore parse errors */ }
    }

    sendMessage({
      text: pendingText || '(see attached file)',
      files: fileParts.length > 0 ? fileParts : undefined,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, mode])

  // Refresh sidebar + usage + conversation after each turn (edit mode only).
  // Plan 23 — also refresh branch metadata, otherwise the next edit/regenerate
  // can't find the just-saved messages in `branchMeta` and silently degrades
  // into a linear send (parent falls back to active_tip on the server).
  // IMPORTANT: only fire when isStreaming TRANSITIONS from true → false. Naive
  // `!isStreaming` would also fire on initial mount and the async fetch would
  // race with `sendMessage` from the pending_message handler — wiping the
  // user's just-typed message until the stream completes.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (mode !== 'edit') { wasStreamingRef.current = isStreaming; return }
    const justFinished = wasStreamingRef.current && !isStreaming
    wasStreamingRef.current = isStreaming
    if (!justFinished) return
    qc.invalidateQueries({ queryKey: ['conversations'] })
    qc.invalidateQueries({ queryKey: ['conversation', convId] })
    if (agentId) qc.invalidateQueries({ queryKey: ['usage', agentId, 'latest'] })
    refreshMessages().catch(() => { /* ignore */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

  // Focus the chat input whenever the conversation id changes (e.g. after
  // creating a new chat and being redirected to the loaded-conversation view).
  // The native `autoFocus` attribute only fires on the initial mount — this
  // covers subsequent convId swaps where the component instance is reused.
  useEffect(() => {
    if (mode !== 'edit') return
    // Let the new view mount first, then focus.
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>(
        'textarea[data-slot="input-group-control"], textarea[placeholder^="Type a message"]',
      )
      el?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [convId, mode])

  // Start live polling when edit-mode streaming ends (so readonly tabs catch up)
  // readonly: start polling when we detect a run is active
  const handleSend = async ({ text, files }: { text: string; files: { url: string; mediaType: string; filename?: string }[] }) => {
    if ((!text.trim() && files.length === 0) || isStreaming || mode !== 'edit') return

    if (files.length === 0) {
      sendMessage({ text })
      return
    }

    // Upload files to server, then send with attachment:// scheme
    const uploadedParts: { type: 'file'; mediaType: string; url: string; filename?: string }[] = []
    await Promise.all(files.map(async (filePart) => {
      try {
        const res = await fetch(filePart.url)
        const blob = await res.blob()
        const file = new File([blob], filePart.filename ?? 'file', { type: filePart.mediaType })
        if (!projectId) throw new Error('No projectId')
        const result = await api.attachments.upload(projectId, [file], {
          agent_id: agentId,
          conversation_id: convId,
        })
        const uploaded = result.attachments[0]
        if (!uploaded) throw new Error('No result')
        uploadedParts.push({
          type: 'file',
          mediaType: filePart.mediaType,
          url: `attachment://${uploaded.attachment_id}`,
          filename: filePart.filename,
        })
      } catch {
        // skip failed upload — message still sends without this file
      }
    }))

    sendMessage({
      text: text || '(see attached file)',
      files: uploadedParts.length > 0 ? uploadedParts : undefined,
    })
  }

  // Build display messages — append live message for readonly observers AND
  // for edit-mode regenerate (which streams via /live-parts because it
  // doesn't go through useChat).
  const displayMessages = liveMessage
    ? [...messages, liveMessage]
    : messages

  // Edit mode is "streaming" when either useChat is active OR the live-parts
  // poller is catching a regenerate stream.
  const displayStreaming = mode === 'edit' ? (isStreaming || liveStreaming) : liveStreaming

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {conversation && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
          <div className="flex flex-col min-w-0 flex-1">
            {mode === 'edit' ? (
              <ConversationTitleEdit
                convId={convId}
                title={conversation.title}
                agentName={conversation.agent.name}
              />
            ) : (
              <span className="font-semibold text-sm truncate">
                {conversation.title ?? conversation.agent.name}
              </span>
            )}
            {conversation.title && (
              <span className="text-xs text-muted-foreground truncate leading-none">
                {conversation.agent.name}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {mode === 'readonly' && (
              <Badge variant="outline" className="text-xs text-muted-foreground">readonly</Badge>
            )}
            {displayStreaming && (
              <Badge variant="outline" className="text-xs text-green-600 border-green-500/40">streaming</Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {conversation.status}
            </Badge>
          </div>
        </div>
      )}

      {/* Message list */}
      <Conversation className="flex-1">
        <ConversationContent className="max-w-3xl mx-auto w-full">
          {displayMessages.length === 0 && !displayStreaming && (
            <Empty>
              <EmptyMedia variant="icon"><Bot /></EmptyMedia>
              <EmptyTitle>{mode === 'readonly' ? 'No messages' : 'Start the conversation'}</EmptyTitle>
              {mode === 'edit' && <EmptyDescription>Type a message below to begin</EmptyDescription>}
            </Empty>
          )}

          {compactionEvents.map((ev, i) => (
            <CompactionIndicator
              key={`compact-${i}`}
              summary={ev.summary}
              removedCount={ev.removed_count}
              tokenSaved={ev.token_saved}
            />
          ))}

          {(() => {
            // Last message index that is actively being streamed (we hide
            // copy + show a live indicator only on this one).
            const lastIdx = displayMessages.length - 1
            return displayMessages.map((msg, idx) => {
              const textContent = msg.parts
                .filter(p => p.type === 'text')
                .map(p => (p as { type: 'text'; text: string }).text)
                .join('\n\n')
              const isStreamingThisMsg =
                displayStreaming && idx === lastIdx && msg.role === 'assistant'
              const meta = branchMeta.get(msg.id)
              const showNavigator = !!meta && meta.sibling_count > 1
              const isEditing = editingId === msg.id
              const canEdit = mode === 'edit' && !displayStreaming && msg.role === 'user'
              const canRegen = mode === 'edit' && !displayStreaming && msg.role === 'assistant' && !!meta?.parent_message_id
              return (
                <div key={msg.id} className="flex flex-col">
                  <Message from={msg.role} className="flex">
                    <MessageContent>
                      {isEditing ? (
                        <MessageEditInput
                          initialText={textContent}
                          onSubmit={(text) => submitEdit(msg.id, text)}
                          onCancel={() => setEditingId(null)}
                          disabled={displayStreaming}
                        />
                      ) : (
                        <>
                          <MessageParts msg={msg} />
                          {isStreamingThisMsg && (
                            <span
                              className="inline-block w-2 h-2 rounded-full bg-primary align-middle ml-1 animate-pulse"
                              aria-label="assistant is responding"
                              title="assistant is responding"
                            />
                          )}
                        </>
                      )}
                    </MessageContent>
                    {!isEditing && textContent && !isStreamingThisMsg && (
                      <div className={`flex items-center gap-1 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} transition-opacity`}>
                        <CopyButton text={textContent} />
                        {showNavigator && meta && (
                          <BranchNavigator
                            currentIndex={meta.current_sibling_index + 1}
                            total={meta.sibling_count}
                            disabled={displayStreaming}
                            onPrev={() => {
                              const target = meta.sibling_ids[meta.current_sibling_index - 1]
                              if (target) switchBranch(target)
                            }}
                            onNext={() => {
                              const target = meta.sibling_ids[meta.current_sibling_index + 1]
                              if (target) switchBranch(target)
                            }}
                          />
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => setEditingId(msg.id)}
                            title="Edit & re-run"
                            className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canRegen && (
                          <button
                            type="button"
                            onClick={() => regenerate(msg.id)}
                            title="Regenerate response"
                            className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </Message>
                </div>
              )
            })
          })()}

          {/* Show standalone thinking indicator when stream has started but no assistant message yet */}
          {displayStreaming &&
           (displayMessages.length === 0 || displayMessages[displayMessages.length - 1]?.role !== 'assistant') && (
            <Message from="assistant" className="flex">
              <MessageContent>
                <span className="inline-flex items-center gap-2 text-muted-foreground text-sm">
                  <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
                  <span>thinking…</span>
                </span>
              </MessageContent>
            </Message>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              {error.message}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Footer: input bar (edit) or context bar only (readonly) */}
      <div className="border-t px-4 py-3 shrink-0">
        <div className="max-w-3xl mx-auto">
          {mode === 'edit' && conversation && (
            <PromptInputProvider>
              <div className="relative">
                <SlashCommandAutocomplete agentId={conversation.agent.id} />
                <PromptInput onSubmit={handleSend} accept="image/*,text/*,.csv,.json,.md,.pdf" multiple>
                  <AttachmentPreviews />
                  <PromptInputTextarea
                    autoFocus
                    placeholder="Type a message… (/ for commands, Enter to send, paste image)"
                  />
                  <PromptInputFooter>
                    <AttachFileButton />
                    <PromptInputSubmit status={status} onStop={() => {}} />
                  </PromptInputFooter>
                </PromptInput>
              </div>
            </PromptInputProvider>
          )}

          {conversation && (
            <div className={`flex items-center gap-3 ${mode === 'edit' ? 'mt-2 px-1' : ''}`}>
              <ContextBar
                agentId={conversation.agent.id}
                conversationId={convId}
                isStreaming={displayStreaming}
                onMemoryClick={() => setMemorySheetOpen(true)}
              />

              {/* Usage badge */}
              {lastUsage && (
                <div className="relative shrink-0 border-l border-gray-500/50 pl-3">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onMouseEnter={() => setShowUsageTip(true)}
                    onMouseLeave={() => setShowUsageTip(false)}
                  >
                    <ArrowDown className="h-3 w-3 text-emerald-500" />
                    <span className="font-mono tabular-nums">{formatTokens(lastUsage.output_tokens)}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <ArrowUp className="h-3 w-3 text-sky-500" />
                    <span className="font-mono tabular-nums">{formatTokens(lastUsage.input_tokens)}</span>
                  </button>
                  {showUsageTip && (
                    <div className="absolute bottom-full right-0 mb-2 bg-popover border rounded-lg shadow-md p-3 text-xs whitespace-nowrap z-20">
                      <p className="font-medium mb-2">Last run{lastUsage.model_id ? ` — ${lastUsage.model_id}` : ''}</p>
                      <div className="space-y-1.5 text-muted-foreground">
                        <div className="flex items-center justify-between gap-6">
                          <span className="flex items-center gap-1.5">
                            <ArrowDown className="h-3 w-3 text-emerald-500" />
                            In (from model)
                          </span>
                          <span className="font-mono text-foreground">{lastUsage.output_tokens.toLocaleString()} tokens</span>
                        </div>
                        <div className="flex items-center justify-between gap-6">
                          <span className="flex items-center gap-1.5">
                            <ArrowUp className="h-3 w-3 text-sky-500" />
                            Out (to model)
                          </span>
                          <span className="font-mono text-foreground">{lastUsage.input_tokens.toLocaleString()} tokens</span>
                        </div>
                        <div className="flex justify-between gap-6 pt-1.5 border-t">
                          <span>Est. cost</span>
                          <span className="font-mono text-foreground">{estimateCost(lastUsage.input_tokens, lastUsage.output_tokens, lastUsage.model_id, pricingMap)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <MemoryPreviewSheet
        agentId={conversation?.agent.id ?? ''}
        conversationId={convId}
        open={memorySheetOpen}
        onOpenChange={setMemorySheetOpen}
      />
    </div>
  )
}
