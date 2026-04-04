'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Image from 'next/image'
import { Building2, LogOut, Menu } from 'lucide-react'
import { useAuthStore } from '@/lib/store/auth.store'
import { useSidebarStore } from '@/lib/store/sidebar.store'
import { Button } from '@jiku/ui'
import { cn } from '@/lib/utils'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(s => s.user)
  const token = useAuthStore(s => s.token)
  const hydrated = useAuthStore(s => s._hydrated)
  const clearAuth = useAuthStore(s => s.clearAuth)
  const router = useRouter()

  useEffect(() => {
if (hydrated && !token) {
      router.replace('/login')
    }
  }, [hydrated, token, router])
  const { collapsed, toggle } = useSidebarStore()
  const pathname = usePathname()

  function handleLogout() {
    clearAuth()
    router.replace('/login')
  }

  if (!hydrated) return null

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className={cn(
        'flex flex-col h-full border-r bg-sidebar shrink-0 transition-all duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}>
        {/* Logo */}
        <div className={cn('flex items-center h-14 border-b', collapsed ? 'justify-center' : 'gap-2 px-3')}>
          <Image src="/logo.svg" alt="Jiku" width={24} height={24} className="shrink-0" />
          {!collapsed && <span className="font-bold text-sm">Jiku Studio</span>}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-1">
          <Link
            href="/home"
            className={cn(
              'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-colors',
              'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              pathname === '/home' && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )}
          >
            <Building2 className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Companies</span>}
          </Link>
        </nav>

        {/* Footer */}
        <div className="p-2 border-t space-y-1">
          {!collapsed && user && (
            <p className="px-2 py-1 text-xs text-muted-foreground truncate">{user.email}</p>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-sm transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="flex items-center h-14 px-4 border-b bg-background shrink-0">
          <Button variant="ghost" size="icon" onClick={toggle} className="mr-2">
            <Menu className="w-4 h-4" />
          </Button>
          <div className="flex-1" />
        </header>
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
