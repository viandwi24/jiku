'use client'

import Link from 'next/link'
import { Bot, Settings } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription } from '@jiku/ui'
import { Button } from '@jiku/ui'
import type { Agent } from '@/lib/api'

interface AgentCardProps {
  agent: Agent
  companySlug: string
  projectSlug: string
}

export function AgentCard({ agent, companySlug, projectSlug }: AgentCardProps) {
  const basePath = `/${companySlug}/${projectSlug}/agents/${agent.id}`
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm">{agent.name}</CardTitle>
          </div>
          <Link href={`${basePath}/settings`}>
            <Button variant="ghost" size="icon" className="h-6 w-6">
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
        {agent.description && (
          <CardDescription className="text-xs mt-1 line-clamp-2">{agent.description}</CardDescription>
        )}
        <Link href={basePath}>
          <Button size="sm" className="w-full mt-2">Chat</Button>
        </Link>
      </CardHeader>
    </Card>
  )
}
