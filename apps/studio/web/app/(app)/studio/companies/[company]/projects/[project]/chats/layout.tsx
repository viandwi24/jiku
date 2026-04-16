'use client'

import { use, useEffect, useState } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { Button } from '@jiku/ui'
import { ConversationListPanel } from '@/components/chat/conversation-list-panel'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ company: string; project: string }>
}

const STORAGE_KEY = 'chats.sidebar.open'

export default function ChatShell({ children, params }: LayoutProps) {
  const { company: companySlug, project: projectSlug } = use(params)

  // Persisted per-user: default open on md+ screens, closed on narrow (mobile).
  // `null` during SSR + initial paint → render matches server, effect hydrates.
  const [open, setOpen] = useState<boolean | null>(null)

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    if (stored === 'true') { setOpen(true); return }
    if (stored === 'false') { setOpen(false); return }
    // No persisted value — default based on viewport width.
    setOpen(typeof window !== 'undefined' ? window.innerWidth >= 768 : true)
  }, [])

  const toggle = (next: boolean) => {
    setOpen(next)
    try { window.localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* ignore */ }
  }

  return (
    <div className="flex overflow-hidden relative" style={{ height: 'calc(100svh - 3rem)' }}>
      {open && (
        <>
          <div className="w-72 shrink-0 h-full">
            <ConversationListPanel
              companySlug={companySlug}
              projectSlug={projectSlug}
              onCollapse={() => toggle(false)}
            />
          </div>
          <div className="w-px bg-border shrink-0" />
        </>
      )}
      <div className="flex-1 h-full overflow-hidden relative">
        {open === false && (
          <Button
            size="sm"
            variant="ghost"
            className="absolute top-2 left-2 z-20 h-7 w-7 p-0"
            title="Show conversation list"
            onClick={() => toggle(true)}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}
        {children}
      </div>
    </div>
  )
}
