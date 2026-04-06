'use client'

import React, { use, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FilesystemEntry, FilesystemFileEntry } from '@/lib/api'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@jiku/ui'
import { toast } from 'sonner'
import {
  Folder, FileText, ChevronRight, Upload, Plus, Trash2, Download,
  RefreshCw, Loader2, Search, Copy, X, Save, Eye, AlertCircle,
  HardDrive, Settings2, Plug, TestTube2, TriangleAlert,
  MoreHorizontal, Pencil, FolderOpen, Paperclip, User,
} from 'lucide-react'
import type { ProjectAttachment } from '@/lib/api'
import dynamic from 'next/dynamic'

// Lazy-load CodeMirror to avoid SSR issues
const CodeEditor = dynamic(() => import('./code-editor'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      Loading editor...
    </div>
  ),
})

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function useProjectId(companySlug: string, projectSlug: string) {
  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })
  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  return projectsData?.projects.find(p => p.slug === projectSlug)?.id ?? ''
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getEntryIcon(entry: FilesystemEntry) {
  if (entry.type === 'folder') return <Folder className="w-4 h-4 text-amber-400 shrink-0" />
  return <FileText className="w-4 h-4 text-blue-400 shrink-0" />
}

// ─── Migration Modal ──────────────────────────────────────────────────────────

interface MigrationModalProps {
  fileCount: number
  totalBytes: number
  pendingAdapterId: string
  pendingCredentialId: string
  projectId: string
  onDone: () => void
  onCancel: () => void
}

function MigrationModal({
  fileCount,
  totalBytes,
  pendingAdapterId,
  pendingCredentialId,
  projectId,
  onDone,
  onCancel,
}: MigrationModalProps) {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ migrated: number; failed: number; errors: string[] } | null>(null)

  async function handleAction(action: 'migrate' | 'reset') {
    setRunning(true)
    try {
      const res = await api.filesystem.migrate(projectId, {
        credential_id: pendingCredentialId,
        adapter_id: pendingAdapterId,
        action,
      })
      setResult({ migrated: res.migrated, failed: res.failed, errors: res.errors })
      qc.invalidateQueries({ queryKey: ['filesystem-config', projectId] })
      toast.success(action === 'migrate' ? `Migrated ${res.migrated} file(s)` : 'Storage reset')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Operation failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-background border rounded-lg shadow-2xl w-full max-w-md p-6 space-y-5">
        <div className="flex items-start gap-3">
          <TriangleAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h2 className="font-semibold text-base">Storage adapter changed</h2>
            <p className="text-sm text-muted-foreground mt-1">
              You have <strong>{fileCount}</strong> file{fileCount !== 1 ? 's' : ''} ({formatSize(totalBytes)}) on the current adapter.
              Choose what to do with them before switching.
            </p>
          </div>
        </div>

        {result ? (
          <div className="space-y-2 text-sm">
            <p className="text-green-600 dark:text-green-400">
              Done — {result.migrated} migrated, {result.failed} failed.
            </p>
            {result.errors.length > 0 && (
              <ul className="text-red-500 text-xs space-y-0.5 max-h-28 overflow-y-auto">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
            <Button className="w-full" onClick={onDone}>Done</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              className="flex flex-col gap-1 text-left p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/50 transition-colors disabled:opacity-50"
              disabled={running}
              onClick={() => handleAction('migrate')}
            >
              <span className="font-medium text-sm">Migrate files</span>
              <span className="text-xs text-muted-foreground">
                Copy all {fileCount} file{fileCount !== 1 ? 's' : ''} from the old adapter to the new one. Safe — keeps your data.
              </span>
            </button>
            <button
              className="flex flex-col gap-1 text-left p-4 rounded-lg border border-red-200 hover:border-red-400 hover:bg-red-50/30 dark:hover:bg-red-950/20 transition-colors disabled:opacity-50"
              disabled={running}
              onClick={() => handleAction('reset')}
            >
              <span className="font-medium text-sm text-red-600 dark:text-red-400">Reset storage</span>
              <span className="text-xs text-muted-foreground">
                Delete all {fileCount} file record{fileCount !== 1 ? 's' : ''} from the database and start fresh on the new adapter.
                Files on the old adapter are NOT deleted.
              </span>
            </button>
            <Button variant="ghost" size="sm" className="self-end" onClick={onCancel} disabled={running}>
              Cancel
            </Button>
          </div>
        )}

        {running && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Working…</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Storage Config Tab ───────────────────────────────────────────────────────

function StorageConfigTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()

  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: ['filesystem-config', projectId],
    queryFn: () => api.filesystem.getConfig(projectId),
    enabled: !!projectId,
  })

  const { data: adaptersData } = useQuery({
    queryKey: ['credential-adapters', 'storage'],
    queryFn: () => api.credentials.adapters('storage'),
    enabled: !!projectId,
  })

  const { data: credsData } = useQuery({
    queryKey: ['project-credentials-storage', projectId],
    queryFn: () => api.credentials.available(projectId, 'storage'),
    enabled: !!projectId,
  })

  const config = configData?.config

  const [selectedAdapterId, setSelectedAdapterId] = useState<string>('')
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>('')
  const [enabled, setEnabled] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  // Sync form state when config loads
  const [synced, setSynced] = useState(false)
  if (config && !synced) {
    setSelectedAdapterId(config.adapter_id ?? '')
    setSelectedCredentialId(config.credential_id ?? '')
    setEnabled(config.enabled ?? false)
    setSynced(true)
  }

  const [migration, setMigration] = useState<{
    fileCount: number
    totalBytes: number
    pendingAdapterId: string
    pendingCredentialId: string
  } | null>(null)

  const saveMutation = useMutation({
    mutationFn: () =>
      api.filesystem.updateConfig(projectId, {
        adapter_id: selectedAdapterId || undefined,
        credential_id: selectedCredentialId || null,
        enabled,
      }),
    onSuccess: (res) => {
      if (res.migration_needed) {
        setMigration({
          fileCount: res.file_count!,
          totalBytes: res.total_size_bytes!,
          pendingAdapterId: res.pending_adapter_id!,
          pendingCredentialId: res.pending_credential_id!,
        })
        return
      }
      qc.invalidateQueries({ queryKey: ['filesystem-config', projectId] })
      toast.success('Storage config saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  async function handleTestConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.filesystem.testConnection(projectId)
      setTestResult(result)
    } catch {
      setTestResult({ ok: false, message: 'Connection test failed' })
    } finally {
      setTesting(false)
    }
  }

  const adapters = adaptersData?.adapters ?? []
  const credentials = credsData?.credentials ?? []

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-xl">
      <div className="space-y-6">
        <div>
          <h2 className="text-base font-semibold">Storage Configuration</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Connect an S3-compatible storage adapter (RustFS, MinIO, AWS S3) to enable the project filesystem.
          </p>
        </div>

        {configLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4">
            {/* Enable toggle */}
            <div className="flex items-center justify-between py-3 border-b">
              <div>
                <p className="text-sm font-medium">Enable filesystem</p>
                <p className="text-xs text-muted-foreground">Allow agents and users to read/write files</p>
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
                onClick={() => setEnabled(v => !v)}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-4' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Adapter */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Adapter</label>
              <select
                className="w-full px-3 py-2 text-sm rounded-md border bg-background"
                value={selectedAdapterId}
                onChange={e => setSelectedAdapterId(e.target.value)}
              >
                <option value="">— select adapter —</option>
                {adapters.map(a => (
                  <option key={a.adapter_id} value={a.adapter_id}>{a.name}</option>
                ))}
              </select>
            </div>

            {/* Credential */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Credential</label>
              <select
                className="w-full px-3 py-2 text-sm rounded-md border bg-background"
                value={selectedCredentialId}
                onChange={e => setSelectedCredentialId(e.target.value)}
              >
                <option value="">— none —</option>
                {credentials.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {credentials.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No storage credentials yet. Add one in Project Settings → Credentials.
                </p>
              )}
            </div>

            {/* Stats */}
            {config && (config.total_files > 0 || config.total_size_bytes > 0) && (
              <div className="flex items-center gap-4 p-3 rounded-md bg-muted/40 text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <HardDrive className="w-4 h-4" />
                  <span>{config.total_files} file{config.total_files !== 1 ? 's' : ''}</span>
                </div>
                <div className="text-muted-foreground">{formatSize(config.total_size_bytes)}</div>
              </div>
            )}

            {/* Test result */}
            {testResult && (
              <div className={`flex items-center gap-2 p-3 rounded-md text-sm ${
                testResult.ok
                  ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
                  : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
              }`}>
                {testResult.ok ? <Plug className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span>{testResult.message}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={testing || !selectedCredentialId}
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <TestTube2 className="w-3.5 h-3.5 mr-1" />}
                Test connection
              </Button>
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}
                Save
              </Button>
            </div>
          </div>
        )}
      </div>

      {migration && (
        <MigrationModal
          fileCount={migration.fileCount}
          totalBytes={migration.totalBytes}
          pendingAdapterId={migration.pendingAdapterId}
          pendingCredentialId={migration.pendingCredentialId}
          projectId={projectId}
          onDone={() => {
            setMigration(null)
            setSynced(false)
          }}
          onCancel={() => setMigration(null)}
        />
      )}
    </div>
  )
}

// ─── Entry Dropdown ───────────────────────────────────────────────────────────

interface EntryDropdownProps {
  entry: FilesystemEntry
  onRename: () => void
  onCopyPath: () => void
  onDelete: () => void
  onOpen?: () => void
}

function EntryDropdown({ entry, onRename, onCopyPath, onDelete, onOpen }: EntryDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
        <button
          className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
          title="More actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[140px]" onClick={e => e.stopPropagation()}>
        {onOpen && (
          <DropdownMenuItem onClick={onOpen} className="text-xs gap-2">
            {entry.type === 'folder' ? <FolderOpen className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {entry.type === 'folder' ? 'Open folder' : 'Open file'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onRename} className="text-xs gap-2">
          <Pencil className="w-3.5 h-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyPath} className="text-xs gap-2">
          <Copy className="w-3.5 h-3.5" />
          Copy path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} className="text-xs gap-2 text-red-500 focus:text-red-500">
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── File Explorer Tab ────────────────────────────────────────────────────────

function FileExplorerTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()

  const [currentPath, setCurrentPath] = useState('/')
  const [selectedFile, setSelectedFile] = useState<FilesystemFileEntry | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [newFileName, setNewFileName] = useState('')
  const [showNewFileInput, setShowNewFileInput] = useState(false)
  const [renamingEntry, setRenamingEntry] = useState<FilesystemEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['files', projectId, currentPath],
    queryFn: () => api.filesystem.list(projectId, currentPath),
    enabled: !!projectId,
  })

  const { data: searchData } = useQuery({
    queryKey: ['files-search', projectId, searchQuery],
    queryFn: () => api.filesystem.search(projectId, searchQuery),
    enabled: !!projectId && searchQuery.length >= 2,
  })

  const writeMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.filesystem.write(projectId, { path, content }),
    onSuccess: (res) => {
      setSelectedFile(res.file)
      setIsDirty(false)
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      toast.success('File saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: (path: string) => api.filesystem.delete(projectId, path),
    onSuccess: () => {
      setSelectedFile(null)
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      toast.success('File deleted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  })

  const deleteFolderMutation = useMutation({
    mutationFn: (path: string) => api.filesystem.deleteFolder(projectId, path),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      toast.success(`Deleted ${res.deleted} file(s)`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete folder failed'),
  })

  const moveMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.filesystem.move(projectId, { from, to }),
    onSuccess: () => {
      setRenamingEntry(null)
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      toast.success('Renamed')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Rename failed'),
  })

  const loadFile = useCallback(async (file: FilesystemFileEntry) => {
    if (isDirty) {
      const ok = confirm('You have unsaved changes. Discard them?')
      if (!ok) return
    }
    try {
      const res = await api.filesystem.content(projectId, file.path)
      setSelectedFile(file)
      setEditorContent(res.content)
      setIsDirty(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load file')
    }
  }, [isDirty, projectId])

  const handleNavigate = (entry: FilesystemEntry) => {
    if (entry.type === 'folder') {
      setCurrentPath(entry.path)
    } else {
      loadFile(entry)
    }
  }

  const breadcrumbs = currentPath.split('/').filter(Boolean)

  const handleCreateFile = () => {
    if (!newFileName.trim()) return
    const path = currentPath === '/' ? `/${newFileName.trim()}` : `${currentPath}/${newFileName.trim()}`
    writeMutation.mutate({ path, content: '' })
    setNewFileName('')
    setShowNewFileInput(false)
  }

  const handleSave = () => {
    if (!selectedFile) return
    writeMutation.mutate({ path: selectedFile.path, content: editorContent })
  }

  const handleRename = () => {
    if (!renamingEntry || !renameValue.trim()) return
    const parentPath = renamingEntry.path.split('/').slice(0, -1).join('/') || '/'
    const to = parentPath === '/' ? `/${renameValue.trim()}` : `${parentPath}/${renameValue.trim()}`
    moveMutation.mutate({ from: renamingEntry.path, to })
  }

  const entries = data?.entries ?? []
  const filteredEntries = searchQuery.length >= 2 && searchData
    ? searchData.files.map(f => ({ ...f, type: 'file' as const }))
    : entries

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Left panel: file tree ── */}
      <div className="w-64 shrink-0 border-r flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-2 border-b">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowNewFileInput(v => !v)} title="New file">
            <Plus className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => refetch()} title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Search */}
        <div className="px-2 py-1.5 border-b">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted text-sm">
            <Search className="w-3 h-3 text-muted-foreground shrink-0" />
            <input
              className="flex-1 bg-transparent outline-none text-xs placeholder:text-muted-foreground"
              placeholder="Search files..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')}><X className="w-3 h-3 text-muted-foreground" /></button>
            )}
          </div>
        </div>

        {/* Breadcrumbs */}
        {!searchQuery && (
          <div className="flex items-center gap-0.5 px-2 py-1.5 border-b text-xs text-muted-foreground overflow-x-auto">
            <button
              className="hover:text-foreground transition-colors shrink-0"
              onClick={() => setCurrentPath('/')}
            >
              /
            </button>
            {breadcrumbs.map((seg, i) => (
              <span key={i} className="flex items-center gap-0.5 shrink-0">
                <ChevronRight className="w-3 h-3" />
                <button
                  className="hover:text-foreground transition-colors"
                  onClick={() => setCurrentPath('/' + breadcrumbs.slice(0, i + 1).join('/'))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* New file input */}
        {showNewFileInput && (
          <div className="flex items-center gap-1 px-2 py-1.5 border-b">
            <input
              autoFocus
              className="flex-1 text-xs bg-muted px-2 py-1 rounded outline-none"
              placeholder="filename.ts"
              value={newFileName}
              onChange={e => setNewFileName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreateFile()
                if (e.key === 'Escape') setShowNewFileInput(false)
              }}
            />
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCreateFile}>
              <Save className="w-3 h-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowNewFileInput(false)}>
              <X className="w-3 h-3" />
            </Button>
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-8 px-4">
              {searchQuery ? 'No files found' : 'Empty folder'}
            </div>
          ) : (
            filteredEntries.map(entry => (
              <div key={entry.path} className="group relative">
                {renamingEntry?.path === entry.path ? (
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <input
                      autoFocus
                      className="flex-1 text-xs bg-muted px-2 py-1 rounded outline-none"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename()
                        if (e.key === 'Escape') setRenamingEntry(null)
                      }}
                    />
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={handleRename}>
                      <Save className="w-3 h-3" />
                    </Button>
                  </div>
                ) : (
                  <button
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors text-left ${
                      selectedFile?.path === entry.path ? 'bg-muted' : ''
                    }`}
                    onClick={() => handleNavigate(entry)}
                  >
                    {getEntryIcon(entry)}
                    <span className="flex-1 truncate">{entry.name}</span>
                    {entry.type === 'file' && (
                      <span className="text-muted-foreground shrink-0 mr-1">{formatSize(entry.size_bytes)}</span>
                    )}
                  </button>
                )}

                {/* ⋯ dropdown */}
                {renamingEntry?.path !== entry.path && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex">
                    <EntryDropdown
                      entry={entry}
                      onOpen={() => handleNavigate(entry)}
                      onRename={() => { setRenamingEntry(entry); setRenameValue(entry.name) }}
                      onCopyPath={() => { navigator.clipboard.writeText(entry.path); toast.success('Path copied') }}
                      onDelete={() => {
                        if (!confirm(`Delete ${entry.type === 'folder' ? 'folder and all contents' : 'file'} "${entry.name}"?`)) return
                        if (entry.type === 'folder') deleteFolderMutation.mutate(entry.path)
                        else deleteMutation.mutate(entry.path)
                      }}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Upload button */}
        <div className="p-2 border-t">
          <label className="flex items-center justify-center gap-2 cursor-pointer w-full py-1.5 text-xs rounded border border-dashed border-border hover:border-muted-foreground/40 text-muted-foreground hover:text-foreground transition-colors">
            <Upload className="w-3.5 h-3.5" />
            Upload files
            <input
              type="file"
              multiple
              className="hidden"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? [])
                if (!files.length) return
                try {
                  await api.filesystem.upload(projectId, currentPath, files)
                  qc.invalidateQueries({ queryKey: ['files', projectId] })
                  toast.success(`Uploaded ${files.length} file(s)`)
                } catch {
                  toast.error('Upload failed')
                }
                e.target.value = ''
              }}
            />
          </label>
        </div>
      </div>

      {/* ── Right panel: editor ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            {/* Editor toolbar */}
            <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
              <span className="text-sm font-medium truncate flex-1">{selectedFile.path}</span>
              {isDirty && <span className="text-xs text-amber-500 shrink-0">Unsaved</span>}
              <div className="flex items-center gap-1 shrink-0">
                <a
                  href={api.filesystem.proxyUrl(projectId, selectedFile.path, 'preview')}
                  target="_blank"
                  rel="noreferrer"
                  title="Preview"
                >
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <Eye className="w-3.5 h-3.5" />
                  </Button>
                </a>
                <a
                  href={api.filesystem.proxyUrl(projectId, selectedFile.path, 'download')}
                  download={selectedFile.name}
                  title="Download"
                >
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <Download className="w-3.5 h-3.5" />
                  </Button>
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-red-500 hover:text-red-600"
                  title="Delete file"
                  onClick={() => {
                    if (!confirm(`Delete "${selectedFile.name}"?`)) return
                    deleteMutation.mutate(selectedFile.path)
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={handleSave}
                  disabled={writeMutation.isPending || !isDirty}
                >
                  {writeMutation.isPending
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <><Save className="w-3.5 h-3.5 mr-1" />Save</>}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => { setSelectedFile(null); setIsDirty(false) }}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            <CodeEditor
              filePath={selectedFile.path}
              value={editorContent}
              onChange={(v) => { setEditorContent(v); setIsDirty(true) }}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            <div className="text-center space-y-2">
              <FileText className="w-8 h-8 mx-auto text-muted-foreground/40" />
              <p>Select a file to edit</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Attachments Tab ──────────────────────────────────────────────────────────

function AttachmentsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['attachments', projectId],
    queryFn: () => api.attachments.list(projectId, { limit: 100 }),
    enabled: !!projectId,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.attachments.delete(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attachments', projectId] })
      toast.success('Deleted')
    },
    onError: err => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  })

  const attachments = data?.attachments ?? []

  function groupByConversation(list: ProjectAttachment[]) {
    const map = new Map<string, ProjectAttachment[]>()
    for (const a of list) {
      const key = a.conversation_id ?? '_none'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(a)
    }
    return map
  }

  const grouped = groupByConversation(attachments)

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold">Chat Attachments</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Files uploaded via chat. {attachments.length} total.
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => refetch()}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : attachments.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Paperclip className="w-8 h-8 opacity-30" />
          <p className="text-sm">No attachments yet</p>
          <p className="text-xs">Files attached to chat messages will appear here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([convId, items]) => (
            <div key={convId} className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1 mb-1">
                <User className="w-3 h-3" />
                <span className="font-mono truncate max-w-[200px]">
                  {convId === '_none' ? 'No conversation' : `conv: ${convId.slice(0, 8)}…`}
                </span>
                <span className="text-muted-foreground/50">·</span>
                <span>{items.length} file{items.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="border rounded-md overflow-hidden">
                {items.map((att, i) => (
                  <div
                    key={att.id}
                    className={`flex items-center gap-3 px-3 py-2 text-sm ${i !== 0 ? 'border-t' : ''} hover:bg-muted/40 group`}
                  >
                    {att.mime_type.startsWith('image/') ? (
                      <div className="w-8 h-8 rounded overflow-hidden shrink-0 bg-muted flex items-center justify-center">
                        <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded bg-muted flex items-center justify-center shrink-0">
                        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-xs font-medium">{att.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatSize(att.size_bytes)} · {att.mime_type} · {att.scope}
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground shrink-0">
                      {new Date(att.created_at).toLocaleDateString()}
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:text-red-500 text-muted-foreground transition-all"
                      title="Delete"
                      onClick={() => {
                        if (!confirm(`Delete "${att.filename}"?`)) return
                        deleteMutation.mutate(att.id)
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'explorer' | 'attachments' | 'config'

function FilesPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const projectId = useProjectId(companySlug, projectSlug)
  const [tab, setTab] = useState<Tab>('explorer')

  const { data: configData } = useQuery({
    queryKey: ['filesystem-config', projectId],
    queryFn: () => api.filesystem.getConfig(projectId),
    enabled: !!projectId,
  })

  const isConfigured = configData?.config?.enabled

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'explorer', label: 'Virtual Disk', icon: HardDrive },
    { id: 'attachments', label: 'Attachments', icon: Paperclip },
    { id: 'config', label: 'Storage Config', icon: Settings2 },
  ]

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-3 border-b bg-background shrink-0">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-sm transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab(t.id)}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.id === 'config' && !isConfigured && configData !== undefined && (
              <span className="ml-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'explorer' ? (
        isConfigured ? (
          <FileExplorerTab projectId={projectId} />
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-sm text-center space-y-3">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
              <h2 className="font-semibold">Virtual Disk not configured</h2>
              <p className="text-sm text-muted-foreground">
                Switch to <strong>Storage Config</strong> to connect an S3-compatible storage adapter.
              </p>
              <Button variant="outline" size="sm" onClick={() => setTab('config')}>
                <Settings2 className="w-3.5 h-3.5 mr-1.5" />
                Configure Storage
              </Button>
            </div>
          </div>
        )
      ) : tab === 'attachments' ? (
        <AttachmentsTab projectId={projectId} />
      ) : (
        <StorageConfigTab projectId={projectId} />
      )}
    </div>
  )
}
import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(FilesPage, 'agents:read')
