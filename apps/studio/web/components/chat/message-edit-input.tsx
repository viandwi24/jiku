'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Textarea } from '@jiku/ui'

export interface MessageEditInputProps {
  initialText: string
  onSubmit: (text: string) => void
  onCancel: () => void
  disabled?: boolean
}

/**
 * Plan 23 — inline editor that replaces a user message's content while it's
 * being edited. Submit creates a new user message branched off the same parent,
 * which starts a new branch and runs the model again.
 */
export function MessageEditInput({ initialText, onSubmit, onCancel, disabled }: MessageEditInputProps) {
  const [text, setText] = useState(initialText)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    // Place caret at end.
    if (textareaRef.current) {
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
        }}
        disabled={disabled}
        className="min-h-[96px] resize-y"
        placeholder="Edit your message…"
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={disabled || !text.trim()}>
          Send
        </Button>
      </div>
    </div>
  )
}
