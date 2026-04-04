import React from 'react'
import { cn } from '../../lib/utils.ts'
import { SendHorizonal } from 'lucide-react'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function ChatInput({ value, onChange, onSend, disabled, placeholder, className }: ChatInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && value.trim()) onSend()
    }
  }

  return (
    <div className={cn('flex items-end gap-2 p-4 border-t bg-background', className)}>
      <textarea
        className={cn(
          'flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm',
          'focus:outline-none focus:ring-2 focus:ring-ring min-h-[40px] max-h-32',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'Type a message...'}
        disabled={disabled}
        rows={1}
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        className={cn(
          'shrink-0 flex items-center justify-center w-9 h-9 rounded-md',
          'bg-primary text-primary-foreground',
          'hover:bg-primary/90 transition-colors',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        <SendHorizonal className="w-4 h-4" />
      </button>
    </div>
  )
}
