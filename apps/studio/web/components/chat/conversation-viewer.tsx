'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { isToolUIPart, isTextUIPart, isStaticToolUIPart, getToolName } from 'ai'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { getToken } from '@/lib/auth'
import { useConversationObserver } from '@/hooks/use-conversation-observer'
import { useLiveConversation } from '@/hooks/use-live-conversation'
import { Avatar, AvatarFallback, Badge, Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@jiku/ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@jiku/ui/components/ai-elements/conversation.tsx'
import { Message, MessageContent, MessageResponse } from '@jiku/ui/components/ai-elements/message.tsx'
import { PromptInput, PromptInputButton, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, usePromptInputAttachments } from '@jiku/ui/components/ai-elements/prompt-input.tsx'
import { Attachments, Attachment, AttachmentPreview, AttachmentInfo, AttachmentRemove } from '@jiku/ui/components/ai-elements/attachments.tsx'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@jiku/ui/components/ai-elements/tool.tsx'
import { ArrowDown, ArrowUp, Bot, Check, Copy, Paperclip } from 'lucide-react'
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
                className="max-w-[200px] max-h-[160px] rounded-lg object-cover border border-white/10"
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
                    <ToolOutput output={part.output} errorText={part.errorText} />
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

export function ConversationViewer({ convId, mode, conversation, initialMessages, projectId }: ConversationViewerProps) {
  const [compactionEvents, setCompactionEvents] = useState<CompactionEvent[]>([])
  const [memorySheetOpen, setMemorySheetOpen] = useState(false)
  const [showUsageTip, setShowUsageTip] = useState(false)
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
    }),
  })

  const isStreaming = status === 'streaming' || status === 'submitted'

  // ── readonly mode: poll live-parts for realtime streaming view ────────────
  const { liveMessage, isStreaming: liveStreaming, start: startLive, stop: stopLive } = useLiveConversation({
    conversationId: convId,
    autoDetect: mode === 'readonly',
    onDone: async () => {
      const fresh = await api.conversations.messages(convId)
      setMessages(fresh.messages.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        parts: m.parts as UIMessage['parts'],
        metadata: {},
      })))
      qc.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

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
      const fresh = await api.conversations.messages(convId)
      setMessages(fresh.messages.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        parts: m.parts as UIMessage['parts'],
        metadata: {},
      })))
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

  // Refresh sidebar + usage after each turn (edit mode only)
  useEffect(() => {
    if (mode === 'edit' && !isStreaming) {
      qc.invalidateQueries({ queryKey: ['conversations'] })
      if (agentId) qc.invalidateQueries({ queryKey: ['usage', agentId, 'latest'] })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

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

  // Build display messages — append live message for readonly observers
  const displayMessages = (mode === 'readonly' && liveMessage)
    ? [...messages, liveMessage]
    : messages

  const displayStreaming = mode === 'edit' ? isStreaming : liveStreaming

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {conversation && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-xs">
              {conversation.agent.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-sm">{conversation.agent.name}</span>
          {conversation.title && (
            <span className="text-xs text-muted-foreground truncate">— {conversation.title}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
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

          {displayMessages.map(msg => {
            const textContent = msg.parts
              .filter(p => p.type === 'text')
              .map(p => (p as { type: 'text'; text: string }).text)
              .join('\n\n')
            return (
              <Message key={msg.id} from={msg.role}>
                <MessageContent>
                  <MessageParts msg={msg} />
                </MessageContent>
                {textContent && (
                  <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <CopyButton text={textContent} />
                  </div>
                )}
              </Message>
            )
          })}

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
          {mode === 'edit' && (
            <PromptInput onSubmit={handleSend} accept="image/*,text/*,.csv,.json,.md,.pdf" multiple>
              <AttachmentPreviews />
              <PromptInputTextarea placeholder="Type a message… (Enter to send, paste image)" />
              <PromptInputFooter>
                <AttachFileButton />
                <PromptInputSubmit status={status} onStop={() => {}} />
              </PromptInputFooter>
            </PromptInput>
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
