'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/auth.store'

export default function RootPage() {
  const token = useAuthStore(s => s.token)
  const hydrated = useAuthStore(s => s._hydrated)
  const router = useRouter()

  useEffect(() => {
    if (!hydrated) return
    router.replace(token ? '/studio' : '/login')
  }, [hydrated, token, router])

  return null
}
