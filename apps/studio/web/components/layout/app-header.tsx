'use client'

import { Separator, SidebarTrigger } from '@jiku/ui'
import { AppBreadcrumb } from './app-breadcrumb'

export function AppHeader() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-6">
      <SidebarTrigger />
      <Separator orientation="vertical" className="self-stretch" />
      <AppBreadcrumb />
    </header>
  )
}
