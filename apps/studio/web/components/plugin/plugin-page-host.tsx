'use client'

import { SlotIsland } from '@/lib/plugins/slot'
import type { RegistryPluginEntry } from '@/lib/plugins/provider'

interface Props {
  entry: RegistryPluginEntry
  subPath: string
  project: { id: string; slug: string; name: string }
  user: { id: string; role: 'owner' | 'admin' | 'member' }
  permissions: string[]
}

export function PluginPageHost({ entry, subPath, project, user, permissions }: Props) {
  return (
    <SlotIsland
      entry={entry}
      subPath={subPath}
      contextBase={{
        project,
        user,
        userPermissions: new Set(permissions),
      }}
    />
  )
}
