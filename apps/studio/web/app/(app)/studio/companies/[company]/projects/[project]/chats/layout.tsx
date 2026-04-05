'use client'

import { use } from 'react'
import { ConversationListPanel } from '@/components/chat/conversation-list-panel'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ company: string; project: string }>
}

export default function ChatShell({ children, params }: LayoutProps) {
  const { company: companySlug, project: projectSlug } = use(params)

  return (
    <div className="flex overflow-hidden" style={{ height: 'calc(100svh - 3rem)' }}>
      <div className="w-72 shrink-0 h-full">
        <ConversationListPanel companySlug={companySlug} projectSlug={projectSlug} />
      </div>
      <div className="w-px bg-border shrink-0" />
      <div className="flex-1 h-full overflow-hidden">
        {children}
      </div>
    </div>
  )
}
