'use client'

import { useRef, useEffect, useMemo, useState, useCallback, type DragEvent, type ChangeEvent } from 'react'
import { useChat } from '@ai-sdk/react'
import { useQuery } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { DefaultChatTransport } from 'ai'
import { ArrowDown, ArrowUp, Bot, User, Paperclip, X, FileText, Image as ImageIcon, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToken } from '@/lib/auth'
import { api } from '@/lib/api'
import { buildPricingMap, estimateCost, formatTokens } from '@/lib/usage'
import { MessageTextWithActiveCommands } from '@/components/chat/active-command-block'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface ChatInterfaceProps {
  conversationId: string
  agentId: string
  projectId: string
  companyId: string
}

interface PendingFile {
  id: string
  /** attachment_id from server after upload */
  attachment_id?: string
  name: string
  mime_type: string
  /** preview URL for images (object URL — local only, not sent to model) */
  previewUrl?: string
  uploading?: boolean
  error?: string
}

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

function AttachmentChip({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  return (
    <div className={`flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded-md bg-muted border text-xs max-w-40 shrink-0 ${file.error ? 'border-red-400' : ''}`}>
      {file.uploading ? (
        <Loader2 className="w-4 h-4 text-muted-foreground shrink-0 animate-spin" />
      ) : file.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.previewUrl} alt={file.name} className="w-5 h-5 rounded object-cover shrink-0" />
      ) : (
        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
      )}
      <span className={`truncate flex-1 ${file.error ? 'text-red-500' : 'text-foreground'}`}>
        {file.error ? 'Upload failed' : file.name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

export function ChatInterface({ conversationId, agentId, projectId, companyId }: ChatInterfaceProps) {
  const [input, setInput] = useState('')
  const [showUsageTooltip, setShowUsageTooltip] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const qc = useQueryClient()

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

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: `${API_URL}/api/conversations/${conversationId}/chat`,
      headers: () => ({
        Authorization: `Bearer ${getToken() ?? ''}`,
      }),
      prepareSendMessagesRequest: ({ id, messages }) => {
        // Only send the last user message — the server loads conversation history
        // from the DB itself. Sending all messages would grow the request body
        // unboundedly as the conversation gets longer.
        const lastUser = [...messages].reverse().find(m => m.role === 'user')
        return {
          body: {
            id,
            messages: lastUser ? [lastUser] : [],
            agent_id: agentId,
            project_id: projectId,
            company_id: companyId,
          },
        }
      },
    }),
    onFinish: () => {
      qc.invalidateQueries({ queryKey: ['usage', agentId, 'latest'] })
    },
  })

  const isLoading = status === 'streaming' || status === 'submitted'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const addFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => f.size <= MAX_FILE_SIZE)

    // Create placeholder chips immediately (with uploading state)
    const placeholders: PendingFile[] = valid.map(f => ({
      id: Math.random().toString(36).slice(2),
      name: f.name,
      mime_type: f.type || 'application/octet-stream',
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      uploading: true,
    }))
    setPendingFiles(prev => [...prev, ...placeholders])

    // Upload to server in parallel
    await Promise.all(valid.map(async (file, i) => {
      const placeholder = placeholders[i]
      try {
        const result = await api.attachments.upload(projectId, [file], {
          agent_id: agentId,
          conversation_id: conversationId,
        })
        const uploaded = result.attachments[0]
        if (!uploaded) throw new Error('No result')
        setPendingFiles(prev => prev.map(p =>
          p.id === placeholder.id
            ? { ...p, attachment_id: uploaded.attachment_id, uploading: false }
            : p
        ))
      } catch {
        setPendingFiles(prev => prev.map(p =>
          p.id === placeholder.id ? { ...p, uploading: false, error: 'Upload failed' } : p
        ))
      }
    }))
  }, [projectId, agentId, conversationId])

  function handleSend() {
    // Block send if still uploading or has errors
    const readyFiles = pendingFiles.filter(f => !f.uploading && !f.error && f.attachment_id)
    if ((!input.trim() && readyFiles.length === 0) || isLoading) return
    if (pendingFiles.some(f => f.uploading)) return // wait for uploads

    const fileParts = readyFiles.map(f => ({
      type: 'file' as const,
      mediaType: f.mime_type,
      // Custom scheme — server resolves this to base64 or proxy_url
      url: `attachment://${f.attachment_id}`,
      filename: f.name,
    }))

    sendMessage({
      text: input || '(see attached file)',
      files: fileParts.length > 0 ? fileParts : undefined,
    })

    // Revoke object URLs to free memory
    pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
    setInput('')
    setPendingFiles([])
  }

  // Drag-and-drop handlers on the whole chat area
  function handleDragEnter(e: DragEvent) {
    e.preventDefault()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }
  function handleDragLeave(e: DragEvent) {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragging(false) }
  }
  function handleDragOver(e: DragEvent) { e.preventDefault() }
  async function handleDrop(e: DragEvent) {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) await addFiles(files)
  }

  async function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) await addFiles(files)
    e.target.value = ''
  }

  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg pointer-events-none">
          <ImageIcon className="w-10 h-10 text-primary/60" />
          <p className="text-sm font-medium text-muted-foreground">Drop files to attach</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-muted-foreground">
            <Bot className="w-8 h-8" />
            <p className="text-sm">Start a conversation</p>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="w-4 h-4 text-primary" />
              </div>
            )}
            <div className={cn(
              'max-w-[75%] rounded-xl px-3.5 py-2.5 text-sm space-y-2',
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground rounded-br-sm'
                : 'bg-muted rounded-bl-sm',
            )}>
              {/* File parts */}
              {msg.parts.filter(p => p.type === 'file').map((part, i) => {
                if (part.type !== 'file') return null
                const isImage = part.mediaType?.startsWith('image/')
                return isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={typeof part.url === 'string' ? part.url : ''}
                    alt="attachment"
                    className="max-w-full rounded-lg max-h-64 object-contain"
                  />
                ) : (
                  <div key={i} className={cn(
                    'flex items-center gap-1.5 text-xs rounded px-2 py-1',
                    msg.role === 'user' ? 'bg-primary-foreground/10' : 'bg-background/50'
                  )}>
                    <FileText className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{(part as { filename?: string }).filename ?? 'file'}</span>
                  </div>
                )
              })}
              {/* Text */}
              <div className="whitespace-pre-wrap wrap-break-word space-y-1.5">
                {msg.parts.map((part, i) =>
                  part.type === 'text' ? <MessageTextWithActiveCommands key={i} text={part.text} isUser={msg.role === 'user'} /> : null,
                )}
              </div>
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                <User className="w-4 h-4" />
              </div>
            )}
          </div>
        ))}
        {error && (
          <div className="flex gap-2 items-start">
            <div className="w-7 h-7 rounded-full bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-destructive" />
            </div>
            <div className="bg-destructive/10 text-destructive rounded-xl rounded-bl-sm px-3.5 py-2.5 text-sm max-w-[75%]">
              <p className="font-medium">Error</p>
              <p className="text-xs mt-0.5 opacity-80">{error.message}</p>
            </div>
          </div>
        )}
        {isLoading && (
          <div className="flex gap-2 items-start">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="bg-muted rounded-xl rounded-bl-sm px-3.5 py-3 flex gap-1">
              <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="p-4 border-t space-y-2">
        {/* Usage badge */}
        {lastUsage && (
          <div className="flex justify-end">
            <div className="relative">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded-md hover:bg-muted"
                onMouseEnter={() => setShowUsageTooltip(true)}
                onMouseLeave={() => setShowUsageTooltip(false)}
              >
                <ArrowDown className="h-3 w-3 text-emerald-500" />
                <span className="font-mono">{formatTokens(lastUsage.output_tokens)}</span>
                <span className="text-muted-foreground/40">·</span>
                <ArrowUp className="h-3 w-3 text-sky-500" />
                <span className="font-mono">{formatTokens(lastUsage.input_tokens)}</span>
              </button>
              {showUsageTooltip && (
                <div className="absolute bottom-full right-0 mb-1.5 bg-popover border rounded-lg shadow-md p-3 text-xs whitespace-nowrap z-10">
                  <p className="font-medium mb-2">
                    Last run — {lastUsage.model_id ?? 'unknown model'}
                    {lastUsage.mode && (
                      <span className="ml-1.5 inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {lastUsage.mode}
                      </span>
                    )}
                  </p>
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
          </div>
        )}

        {/* Pending file chips */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pendingFiles.map(f => (
              <AttachmentChip
                key={f.id}
                file={f}
                onRemove={() => setPendingFiles(prev => prev.filter(x => x.id !== f.id))}
              />
            ))}
          </div>
        )}

        {/* Input row */}
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,text/*,.csv,.json,.md,.pdf"
            className="hidden"
            onChange={handleFileInput}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="shrink-0 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
            title="Attach file"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-10.5 max-h-32"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            onPaste={async e => {
              const items = Array.from(e.clipboardData.items)
              const imageItems = items.filter(i => i.type.startsWith('image/'))
              if (imageItems.length > 0) {
                e.preventDefault()
                const files = imageItems.map(i => i.getAsFile()).filter(Boolean) as File[]
                await addFiles(files)
              }
            }}
            placeholder="Type a message… (Enter to send, paste image)"
            rows={1}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && pendingFiles.length === 0)}
            className="shrink-0 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

