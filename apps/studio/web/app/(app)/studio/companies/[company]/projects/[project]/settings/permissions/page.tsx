'use client'

import { ShieldCheck } from 'lucide-react'

export default function ProjectPermissionsPage() {
  return (
    <div className="rounded-lg border p-8 text-center">
      <ShieldCheck className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
      <p className="font-medium text-sm mb-1">Coming Soon</p>
      <p className="text-xs text-muted-foreground">Project-level permissions and member management will be available in a future update.</p>
    </div>
  )
}
