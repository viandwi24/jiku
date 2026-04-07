'use client'

import Link from 'next/link'
import { Bot, MessageSquare, Settings } from 'lucide-react'
import {
  Avatar,
  AvatarFallback,
  Button,
  Card,
  CardContent,
  CardFooter,
} from '@jiku/ui'
import type { Agent } from '@/lib/api'

interface AgentCardProps {
  agent: Agent
  companySlug: string
  projectSlug: string
}

export function AgentCard({ agent, companySlug, projectSlug }: AgentCardProps) {
  const basePath = `/studio/companies/${companySlug}/projects/${projectSlug}/agents/${agent.slug}`
  const chatHref = `/studio/companies/${companySlug}/projects/${projectSlug}/chats?agent=${agent.slug}`

  return (
    <Card className="group hover:shadow-sm transition-shadow">
      <CardContent className="gap-3 flex flex-col">
        <div className="flex items-start gap-3">
          {/* <Avatar className="h-9 w-9 mt-0.5 shrink-0">
            <AvatarFallback className="text-sm bg-primary/10 text-primary font-medium">
              {agent.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar> */}
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{agent.name}</p>
            {agent.description ? (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{agent.description}</p>
            ) : '-'}
          </div>
        </div>
        <div className="flex gap-3">
          <Button asChild size="sm" className="flex-1">
            <Link href={chatHref}>
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              Chat
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="flex-1">
            <Link href={basePath}>
              <Bot className="h-3.5 w-3.5 mr-1.5" />
              Overview
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
