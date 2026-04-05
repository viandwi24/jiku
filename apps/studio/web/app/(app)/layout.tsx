'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/auth.store'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const token = useAuthStore(s => s.token)
  const hydrated = useAuthStore(s => s._hydrated)
  const router = useRouter()

  useEffect(() => {
    if (hydrated && !token) router.replace('/login')
  }, [hydrated, token, router])

  if (!hydrated) return null

  return <>{children}</>
}
