'use client'

import { use, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectorMessageItem } from '@/lib/api'
import { Badge, Button } from '@jiku/ui'
import { ArrowLeft, ArrowDown, ArrowUp } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ company: string; project: string; connector: string }>
}

function MessageRow({ message }: { message: ConnectorMessageItem }) {
  const [expanded, setExpanded] = useState(false)
  const isInbound = message.direction === 'inbound'

  return (
    <div className="border-b last:border-0">
      <button
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] text-muted-foreground/60 font-mono shrink-0 pt-0.5 w-20">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
        <span className={`shrink-0 ${isInbound ? 'text-blue-600' : 'text-green-600'}`}>
          {isInbound
            ? <ArrowDown className="h-3.5 w-3.5" />
            : <ArrowUp className="h-3.5 w-3.5" />
          }
        </span>
        <Badge
          variant="outline"
          className={`text-[10px] px-1.5 py-0.5 font-normal shrink-0 ${
            isInbound
              ? 'border-blue-500/40 text-blue-600 bg-blue-500/5'
              : 'border-green-500/40 text-green-600 bg-green-500/5'
          }`}
        >
          {message.direction}
        </Badge>
        <span className="flex-1 text-xs text-muted-foreground font-mono truncate">
          {message.content_snapshot ?? JSON.stringify(message.ref_keys)}
        </span>
        {message.ref_keys?.agent_id && (
          <span className="text-[10px] text-muted-foreground/50 shrink-0 font-mono">
            {message.ref_keys.agent_id.slice(0, 8)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <p className="text-muted-foreground/60 mb-0.5">Ref Keys</p>
              <pre className="font-mono text-muted-foreground bg-muted/20 rounded p-2">
                {JSON.stringify(message.ref_keys, null, 2)}
              </pre>
            </div>
            {message.ref_keys?.agent_id && (
              <div>
                <p className="text-muted-foreground/60 mb-0.5">Agent</p>
                <p className="font-mono text-muted-foreground bg-muted/20 rounded p-2">{message.ref_keys.agent_id}</p>
              </div>
            )}
          </div>
          {message.content_snapshot && (
            <div>
              <p className="text-[11px] text-muted-foreground/60 mb-0.5">Content</p>
              <pre className="text-[11px] font-mono text-muted-foreground bg-muted/20 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                {message.content_snapshot}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function MessagesPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, connector: connectorId } = use(params)

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/channels/${connectorId}`

  const { data, isLoading } = useQuery({
    queryKey: ['connector-messages', connectorId],
    queryFn: () => api.connectors.messages.list(connectorId, 100),
    refetchInterval: 10_000,
  })

  const messages = data?.messages ?? []

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" asChild>
          <Link href={base}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-xl font-semibold flex-1">Message Log</h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ArrowDown className="h-3 w-3 text-blue-600" /> Inbound
          </span>
          <span className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3 text-green-600" /> Outbound
          </span>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading messages...</p>}

      {!isLoading && messages.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No messages yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Messages will appear here when your connector processes conversations.
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          {messages.map(message => (
            <MessageRow key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  )
}
