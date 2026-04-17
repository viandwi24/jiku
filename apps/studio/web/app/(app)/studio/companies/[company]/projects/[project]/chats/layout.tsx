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

  const [open, setOpen] = useState<boolean | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    if (stored === 'true') { setOpen(true); return }
    if (stored === 'false') { setOpen(false); return }
    setOpen(typeof window !== 'undefined' ? window.innerWidth >= 768 : true)
  }, [])

  const toggle = (next: boolean) => {
    setOpen(next)
    if (!isMobile) {
      try { window.localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* ignore */ }
    }
  }

  const panel = (
    <ConversationListPanel
      companySlug={companySlug}
      projectSlug={projectSlug}
      onCollapse={() => toggle(false)}
    />
  )

  return (
    <div className="flex overflow-hidden relative" style={{ height: 'calc(100svh - 3rem)' }}>
      {/* Desktop: inline sidebar */}
      {open && !isMobile && (
        <>
          <div className="w-72 shrink-0 h-full">{panel}</div>
          <div className="w-px bg-border shrink-0" />
        </>
      )}

      {/* Mobile: overlay with backdrop */}
      {open && isMobile && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-30 animate-in fade-in duration-150"
            style={{ top: '3rem' }}
            onClick={() => toggle(false)}
          />
          <div
            className="fixed inset-y-0 left-0 w-72 z-40 bg-background border-r shadow-lg animate-in slide-in-from-left duration-150"
            style={{ top: '3rem' }}
          >
            {panel}
          </div>
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
