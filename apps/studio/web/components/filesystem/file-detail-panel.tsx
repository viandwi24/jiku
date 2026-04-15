'use client'

// Side-effect import: registers all built-in view adapters into the static registry.
import './adapters/index'

import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FilesystemFileEntry } from '@/lib/api'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@jiku/ui'
import { Eye, Code2, Download, Trash2, Save, X, Loader2 } from 'lucide-react'
import { getAllAdaptersForFile } from '@/lib/file-view-adapters'
import { useOptionalPluginUIRegistry } from '@/lib/plugins/provider'
import { loadMountable } from '@/lib/plugins/mount-runtime'
import { getToken } from '@/lib/auth'
import dynamic from 'next/dynamic'
import { cn } from '@/lib/utils'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

const CodeEditor = dynamic(
  () => import('@/app/(app)/studio/companies/[company]/projects/[project]/disk/code-editor'),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading editor...
      </div>
    ),
  },
)

interface FileDetailPanelProps {
  projectId: string
  file: FilesystemFileEntry
  content: string
  isDirty: boolean
  isSaving: boolean
  onContentChange: (value: string) => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
  /** Hide save + delete buttons when false. Default true. */
  canWrite?: boolean
}

// ── Plugin file-view-adapter island ─────────────────────────────────────────

interface PluginAdapterEntry {
  type: 'plugin'
  id: string           // `${pluginId}:${entryId}`
  label: string
  pluginId: string
  entryId: string
  assetUrl: string
  pluginVersion: string
}

function PluginAdapterIsland({
  entry,
  projectId,
  file,
  content,
}: {
  entry: PluginAdapterEntry
  projectId: string
  file: FilesystemFileEntry
  content: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!hostRef.current) return
    let cancelled = false
    let unmountFn: (() => void) | null = null

    ;(async () => {
      try {
        const mod = await loadMountable(entry.assetUrl, entry.pluginVersion)
        if (cancelled || !hostRef.current) return
        const meta: Record<string, unknown> = {
          label: entry.label,
          projectId,
          path: file.path,
          filename: file.name,
          content,
          apiBaseUrl: BASE_URL,
          authToken: getToken(),
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const maybeUnmount = await mod.mount(hostRef.current, {} as any, meta)
        if (cancelled) { maybeUnmount?.(); return }
        unmountFn = maybeUnmount ?? null
      } catch (e) {
        if (!cancelled) console.error(`[file-view-adapter] ${entry.pluginId}:${entry.entryId}`, e)
      }
    })()

    return () => {
      cancelled = true
      try { unmountFn?.() } catch { /* plugin misbehaved */ }
    }
  // Remount when file changes or entry changes — NOT on every content keystroke
  // (content is only needed for initial CSV render, passed via meta once)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.assetUrl, entry.pluginVersion, entry.label, projectId, file.path])

  // `relative` creates the containing block so the plugin can use position:absolute;inset:0
  // to fill this host div with guaranteed defined dimensions.
  return <div ref={hostRef} className="flex-1 flex flex-col overflow-hidden relative" />
}

// ── Unified adapter type ─────────────────────────────────────────────────────

type AdapterItem =
  | { type: 'static'; id: string; label: string; component: import('@/lib/file-view-adapters').FileViewAdapter['component'] }
  | PluginAdapterEntry

// ── Main component ───────────────────────────────────────────────────────────

export function FileDetailPanel({
  projectId,
  file,
  content,
  isDirty,
  isSaving,
  onContentChange,
  onSave,
  onDelete,
  onClose,
  canWrite = true,
}: FileDetailPanelProps) {
  const { data: activePluginsData } = useQuery({
    queryKey: ['project-plugins-active', projectId],
    queryFn: () => api.plugins.listActive(projectId),
    staleTime: 60_000,
  })
  const registry = useOptionalPluginUIRegistry()

  // Static adapters (built-in, e.g. Markdown)
  const activePluginIds = activePluginsData?.plugins.map(p => p.plugin_id) ?? []
  const staticAdapters = getAllAdaptersForFile(file.name, activePluginIds)

  // Plugin-contributed file.view.adapter entries
  const fileExt = file.name.includes('.') ? '.' + file.name.split('.').pop()!.toLowerCase() : ''
  const pluginAdapters: PluginAdapterEntry[] = (registry?.entriesBySlot['file.view.adapter'] ?? [])
    .filter(e => {
      const exts = (e.meta as { extensions?: string[] }).extensions ?? []
      return exts.includes(fileExt)
    })
    .map(e => ({
      type: 'plugin' as const,
      id: `${e.pluginId}:${e.id}`,
      label: String((e.meta as { label?: string }).label ?? e.id),
      pluginId: e.pluginId,
      entryId: e.id,
      assetUrl: e.assetUrl,
      pluginVersion: e.pluginVersion,
    }))

  // Merge: static first, then plugin
  const adapters: AdapterItem[] = [
    ...staticAdapters.map(a => ({ type: 'static' as const, id: a.id, label: a.label, component: a.component })),
    ...pluginAdapters,
  ]
  const hasAdapters = adapters.length > 0

  const [isViewMode, setIsViewMode] = useState(true)
  // `preferredAdapterId` stores the user's explicit choice. When it doesn't
  // match any available adapter (e.g. after a file change) we fall back to the
  // first available adapter — so the selector is never visually blank.
  const [preferredAdapterId, setPreferredAdapterId] = useState<string>('')

  useEffect(() => {
    setIsViewMode(true)
    setPreferredAdapterId('')
  }, [file.path])

  // Resolve the effective adapter id: use the user's preference if it still
  // exists in the current adapter list, otherwise fall back to the first one.
  // This computed value is always valid when adapters are available, eliminating
  // the race where adapters load after the preference was reset.
  const resolvedAdapterId = adapters.find(a => a.id === preferredAdapterId)?.id
    ?? adapters[0]?.id
    ?? ''

  const activeAdapter = isViewMode
    ? (adapters.find(a => a.id === resolvedAdapterId) ?? null)
    : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-sm font-medium truncate flex-1">{file.path}</span>
        {isDirty && <span className="text-xs text-amber-500 shrink-0">Unsaved</span>}

        {/* View / Code tabs + adapter selector */}
        {hasAdapters && (
          <div className="flex items-center gap-1 shrink-0">
            {/* Adapter selector — left of tabs, only in View mode */}
            {isViewMode && adapters.length > 0 && (
              <Select value={resolvedAdapterId} onValueChange={setPreferredAdapterId}>
                <SelectTrigger className="h-6 text-[11px] w-20 px-1.5 gap-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {adapters.map(a => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Tab buttons */}
            <div className="flex items-center border rounded-md overflow-hidden text-xs">
              <button
                onClick={() => setIsViewMode(true)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 transition-colors',
                  isViewMode
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted/60 text-muted-foreground',
                )}
              >
                <Eye className="h-3 w-3" />
                View
              </button>
              <button
                onClick={() => setIsViewMode(false)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 transition-colors',
                  !isViewMode
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted/60 text-muted-foreground',
                )}
              >
                <Code2 className="h-3 w-3" />
                Code
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <a
            href={api.filesystem.proxyUrl(projectId, file.path, 'download')}
            download={file.name}
            title="Download"
          >
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <Download className="w-3.5 h-3.5" />
            </Button>
          </a>
          {canWrite && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-500 hover:text-red-600"
                title="Delete file"
                onClick={() => {
                  if (!confirm(`Delete "${file.name}"?`)) return
                  onDelete()
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={onSave}
                disabled={isSaving || !isDirty}
              >
                {isSaving
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <><Save className="w-3.5 h-3.5 mr-1" />Save</>}
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Content area */}
      {activeAdapter ? (
        activeAdapter.type === 'static' ? (
          <activeAdapter.component
            projectId={projectId}
            content={content}
            filename={file.name}
            path={file.path}
          />
        ) : (
          <PluginAdapterIsland
            key={activeAdapter.id}
            entry={activeAdapter}
            projectId={projectId}
            file={file}
            content={content}
          />
        )
      ) : (
        <CodeEditor
          filePath={file.path}
          value={content}
          onChange={canWrite ? (v) => onContentChange(v) : () => { /* read-only */ }}
        />
      )}
    </div>
  )
}
