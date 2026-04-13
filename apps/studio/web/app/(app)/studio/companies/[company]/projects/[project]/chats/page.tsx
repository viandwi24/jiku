'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileUIPart } from 'ai'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Empty,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@jiku/ui'
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from '@jiku/ui/components/ai-elements/prompt-input.tsx'
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  AttachmentRemove,
} from '@jiku/ui/components/ai-elements/attachments.tsx'
import { Bot, Check, ChevronsUpDown, MessageSquare, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
  searchParams: Promise<{ agent?: string }>
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

function ChatsPage({ params, searchParams }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const { agent: preselectedAgentSlug } = use(searchParams)
  const router = useRouter()
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: agentsData } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })
  const agents = agentsData?.agents ?? []

  const preselected = agents.find(a => a.slug === preselectedAgentSlug) ?? null
  const [selectedAgent, setSelectedAgent] = useState(preselected)
  const [open, setOpen] = useState(false)

  // Sync preselected once agents load
  if (preselectedAgentSlug && !selectedAgent && agents.length > 0) {
    const found = agents.find(a => a.slug === preselectedAgentSlug)
    if (found) setSelectedAgent(found)
  }

  const createMutation = useMutation({
    mutationFn: (agentId: string) => api.conversations.create(agentId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['conversations', project?.id] })
      router.push(`/studio/companies/${companySlug}/projects/${projectSlug}/chats/${data.conversation.id}`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create conversation'),
  })

  async function handleSend({ text, files }: { text: string; files: FileUIPart[] }) {
    if (!selectedAgent) {
      toast.error('Select an agent first')
      return
    }
    // Store pending message in sessionStorage so the conversation page can send it
    if (text.trim()) {
      sessionStorage.setItem('pending_message', text.trim())
    }
    // Upload files now (before conversation exists — we use a temp conversation_id = 'pending')
    // They'll be picked up by the conv page via sessionStorage
    if (files.length > 0 && project?.id) {
      try {
        const uploaded: string[] = []
        await Promise.all(files.map(async (filePart) => {
          const res = await fetch(filePart.url)
          const blob = await res.blob()
          const file = new File([blob], filePart.filename ?? 'file', { type: filePart.mediaType })
          const result = await api.attachments.upload(project.id, [file], { agent_id: selectedAgent.id })
          const att = result.attachments[0]
          if (att) uploaded.push(JSON.stringify({ attachment_id: att.attachment_id, mediaType: filePart.mediaType, filename: filePart.filename }))
        }))
        if (uploaded.length > 0) sessionStorage.setItem('pending_files', JSON.stringify(uploaded))
      } catch {
        // Non-fatal: proceed without files
      }
    }
    createMutation.mutate(selectedAgent.id)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex items-center justify-center">
        <Empty>
          <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
          <EmptyTitle>Start a conversation</EmptyTitle>
          <EmptyDescription>Select an agent and type a message to begin</EmptyDescription>
        </Empty>
      </div>

      <div className="border-t px-4 py-3 shrink-0">
        <div className="max-w-3xl mx-auto space-y-2">
          {/* Agent selector */}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                <Bot className="h-3.5 w-3.5" />
                {selectedAgent?.name ?? 'Select agent'}
                <ChevronsUpDown className="h-3 w-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search agents..." className="h-9" />
                <CommandEmpty>No agents found.</CommandEmpty>
                <CommandList>
                  <CommandGroup>
                    {agents.map(agent => (
                      <CommandItem
                        key={agent.id}
                        value={agent.name}
                        onSelect={() => { setSelectedAgent(agent); setOpen(false) }}
                      >
                        <span className="text-sm truncate">{agent.name}</span>
                        <Check className={cn('ml-auto h-4 w-4', selectedAgent?.id === agent.id ? 'opacity-100' : 'opacity-0')} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {/* Input */}
          <PromptInput onSubmit={handleSend} accept="image/*,text/*,.csv,.json,.md,.pdf" multiple>
            <AttachmentPreviews />
            <PromptInputTextarea placeholder="Type a message… (Enter to send, paste image)" />
            <PromptInputFooter>
              <AttachFileButton />
              <PromptInputSubmit disabled={!selectedAgent || createMutation.isPending} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  )
}
import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(ChatsPage, 'chats:read')
