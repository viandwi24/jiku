'use client'

import { useMemo } from 'react'
import { getToken } from '../lib/auth'

interface UseAttachmentUrlOptions {
  attachmentId: string
  projectId?: string
}

/**
 * Generate an authenticated URL for serving attachment content.
 * Injects JWT token as query parameter so <img src> and other elements work.
 *
 * Usage:
 * ```tsx
 * const url = useAttachmentUrl({ attachmentId: 'abc123' })
 * return <img src={url} alt="screenshot" />
 * ```
 */
export function useAttachmentUrl({ attachmentId }: UseAttachmentUrlOptions): string {
  const token = getToken()

  return useMemo(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
    const url = new URL(`/api/attachments/${attachmentId}/inline`, baseUrl)

    if (token) {
      url.searchParams.set('token', token)
    }

    return url.toString()
  }, [attachmentId, token])
}
