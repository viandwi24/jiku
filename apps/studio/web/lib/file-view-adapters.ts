import type { ComponentType } from 'react'

export interface FileViewAdapterProps {
  projectId: string
  content: string
  filename: string
  path: string
}

export interface FileViewAdapter {
  id: string
  label: string
  /** File extensions this adapter handles, lowercase with dot e.g. '.md' */
  extensions: string[]
  component: ComponentType<FileViewAdapterProps>
  /** If set, adapter is only active when this plugin is enabled for the project */
  pluginId?: string
}

const registry: FileViewAdapter[] = []

export function registerAdapter(adapter: FileViewAdapter) {
  const existing = registry.findIndex(a => a.id === adapter.id)
  if (existing >= 0) {
    registry[existing] = adapter
  } else {
    registry.push(adapter)
  }
}

function getExt(filename: string): string {
  return filename.includes('.')
    ? '.' + filename.split('.').pop()!.toLowerCase()
    : ''
}

/**
 * Returns the first (best) adapter for a file, or null if none available.
 */
export function getAdapterForFile(
  filename: string,
  activePluginIds: string[],
): FileViewAdapter | null {
  return getAllAdaptersForFile(filename, activePluginIds)[0] ?? null
}

/**
 * Returns ALL compatible adapters for a file (in registration order).
 * Used to populate the "View as" selector.
 */
export function getAllAdaptersForFile(
  filename: string,
  activePluginIds: string[],
): FileViewAdapter[] {
  const ext = getExt(filename)
  return registry.filter(adapter => {
    if (!adapter.extensions.includes(ext)) return false
    if (adapter.pluginId && !activePluginIds.includes(adapter.pluginId)) return false
    return true
  })
}
