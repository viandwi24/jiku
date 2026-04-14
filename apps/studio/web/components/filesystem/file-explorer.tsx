'use client'

import React, { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FilesystemEntry, FilesystemFileEntry } from '@/lib/api'
import {
  Button,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
  Badge,
} from '@jiku/ui'
import { toast } from 'sonner'
import {
  Folder, FileText, ChevronRight, Upload, Plus,
  RefreshCw, Loader2, Search, Copy, X, Save, Eye,
  MoreHorizontal, Pencil, FolderOpen, Trash2, FolderPlus,
  Lock, Shield, Check,
} from 'lucide-react'
import { FileDetailPanel } from './file-detail-panel'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getEntryIcon(entry: FilesystemEntry) {
  if (entry.type === 'folder') return <Folder className="w-4 h-4 text-amber-400 shrink-0" />
  return <FileText className="w-4 h-4 text-blue-400 shrink-0" />
}

interface EntryDropdownProps {
  entry: FilesystemEntry
  onRename: () => void
  onCopyPath: () => void
  onDelete: () => void
  onOpen?: () => void
  onSetPermission: (permission: 'read' | 'read+write' | null) => void
}

export function EntryDropdown({ entry, onRename, onCopyPath, onDelete, onOpen, onSetPermission }: EntryDropdownProps) {
  const current = entry.tool_permission ?? null
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
      <DropdownMenuContent align="end" className="min-w-40" onClick={e => e.stopPropagation()}>
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-xs gap-2">
            <Shield className="w-3.5 h-3.5" />
            Tool permission
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-52">
            <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
              Controls agent filesystem tools (fs_write, fs_edit, fs_delete, etc.). UI edits are never gated.
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onSetPermission('read+write')} className="text-xs gap-2">
              {current === 'read+write' ? <Check className="w-3.5 h-3.5" /> : <span className="w-3.5" />}
              Read + Write
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSetPermission('read')} className="text-xs gap-2">
              {current === 'read' ? <Check className="w-3.5 h-3.5" /> : <span className="w-3.5" />}
              Read only
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSetPermission(null)} className="text-xs gap-2">
              {current === null ? <Check className="w-3.5 h-3.5" /> : <span className="w-3.5" />}
              Inherit from parent
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} className="text-xs gap-2 text-red-500 focus:text-red-500">
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface PermissionBadgeProps {
  projectId: string
  entry: FilesystemEntry
}

export function ToolPermissionBadge({ projectId, entry }: PermissionBadgeProps) {
  const { data } = useQuery({
    queryKey: ['file-permission', projectId, entry.path],
    queryFn: () => api.filesystem.getPermission(projectId, entry.path),
    enabled: !!projectId && !!entry.path,
    staleTime: 10_000,
  })
  if (!data) {
    // Fast-path: if entry has explicit read, show lock immediately.
    if (entry.tool_permission === 'read') {
      return (
        <Lock className="w-3 h-3 text-amber-500 shrink-0" />
      )
    }
    return null
  }
  if (data.effective === 'read+write') return null
  const tooltip =
    data.source === 'self'
      ? 'Read-only (set on this item)'
      : data.source === 'inherited'
        ? `Read-only (inherited from ${data.source_path ?? 'parent'})`
        : 'Read-only (default)'
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 inline-flex items-center">
            <Lock className={`w-3 h-3 ${data.source === 'self' ? 'text-amber-500' : 'text-muted-foreground'}`} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export interface FileExplorerProps {
  projectId: string
  /**
   * Restrict navigation to this path prefix (e.g. "/skills/my-skill").
   * Users cannot navigate above this path.
   * Defaults to "/" (full filesystem access).
   */
  rootPath?: string
  /** Hide the upload button. Default false. */
  hideUpload?: boolean
}

export function FileExplorer({ projectId, rootPath, hideUpload }: FileExplorerProps) {
  const qc = useQueryClient()

  // normalizedRoot: '/skills/my-skill' (no trailing slash, empty string = full access)
  const normalizedRoot = rootPath ? rootPath.replace(/\/$/, '') : ''

  const [currentPath, setCurrentPath] = useState(normalizedRoot || '/')
  const [selectedFile, setSelectedFile] = useState<FilesystemFileEntry | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [newFileName, setNewFileName] = useState('')
  const [showNewFileInput, setShowNewFileInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
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

  const setPermissionMutation = useMutation({
    mutationFn: ({ path, type, permission }: { path: string; type: 'file' | 'folder'; permission: 'read' | 'read+write' | null }) =>
      api.filesystem.setPermission(projectId, { path, type, permission }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      qc.invalidateQueries({ queryKey: ['file-permission', projectId] })
      const label = vars.permission === null ? 'inherit from parent' : vars.permission
      toast.success(`Tool permission set: ${label}`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update permission'),
  })

  const createFolderMutation = useMutation({
    mutationFn: (folderPath: string) => api.filesystem.createFolder(projectId, folderPath),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files', projectId] })
      toast.success('Folder created')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Create folder failed'),
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

  const navigate = (path: string) => {
    // Prevent navigating above rootPath
    if (normalizedRoot && !path.startsWith(normalizedRoot)) return
    setCurrentPath(path)
  }

  const handleNavigate = (entry: FilesystemEntry) => {
    if (entry.type === 'folder') {
      navigate(entry.path)
    } else {
      loadFile(entry)
    }
  }

  // Breadcrumbs relative to rootPath
  const rootDepth = normalizedRoot ? normalizedRoot.split('/').filter(Boolean).length : 0
  const fullSegments = currentPath.split('/').filter(Boolean)
  const relativeSegments = fullSegments.slice(rootDepth)

  const handleCreateFile = () => {
    if (!newFileName.trim()) return
    const path = currentPath === '/' ? `/${newFileName.trim()}` : `${currentPath}/${newFileName.trim()}`
    writeMutation.mutate({ path, content: '' })
    setNewFileName('')
    setShowNewFileInput(false)
  }

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return
    const path = currentPath === '/' ? `/${newFolderName.trim()}` : `${currentPath}/${newFolderName.trim()}`
    createFolderMutation.mutate(path)
    setNewFolderName('')
    setShowNewFolderInput(false)
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
    ? searchData.files
        .filter(f => !normalizedRoot || f.path.startsWith(normalizedRoot + '/') || f.path === normalizedRoot)
        .map(f => ({ ...f, type: 'file' as const }))
    : entries

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Left panel: file tree ── */}
      <div className="w-64 shrink-0 border-r flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-2 border-b">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setShowNewFileInput(v => !v); setShowNewFolderInput(false) }} title="New file">
            <Plus className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setShowNewFolderInput(v => !v); setShowNewFileInput(false) }} title="New folder">
            <FolderPlus className="w-3.5 h-3.5" />
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
              onClick={() => navigate(normalizedRoot || '/')}
            >
              /
            </button>
            {relativeSegments.map((seg, i) => (
              <span key={i} className="flex items-center gap-0.5 shrink-0">
                <ChevronRight className="w-3 h-3" />
                <button
                  className="hover:text-foreground transition-colors"
                  onClick={() => {
                    const fullPath = '/' + fullSegments.slice(0, rootDepth + i + 1).join('/')
                    navigate(fullPath)
                  }}
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
              placeholder="filename.md"
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

        {/* New folder input */}
        {showNewFolderInput && (
          <div className="flex items-center gap-1 px-2 py-1.5 border-b">
            <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <input
              autoFocus
              className="flex-1 text-xs bg-muted px-2 py-1 rounded outline-none"
              placeholder="folder-name"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreateFolder()
                if (e.key === 'Escape') setShowNewFolderInput(false)
              }}
            />
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCreateFolder}>
              <Save className="w-3 h-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowNewFolderInput(false)}>
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
                    <ToolPermissionBadge projectId={projectId} entry={entry} />
                    {entry.type === 'file' && (
                      <span className="text-muted-foreground shrink-0 mr-1">{formatSize(entry.size_bytes)}</span>
                    )}
                  </button>
                )}

                {renamingEntry?.path !== entry.path && (
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto flex">
                    <EntryDropdown
                      entry={entry}
                      onOpen={() => handleNavigate(entry)}
                      onRename={() => { setRenamingEntry(entry); setRenameValue(entry.name) }}
                      onCopyPath={() => { navigator.clipboard.writeText(entry.path); toast.success('Path copied') }}
                      onSetPermission={(permission) =>
                        setPermissionMutation.mutate({ path: entry.path, type: entry.type, permission })
                      }
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
        {!hideUpload && (
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
                    const res = await api.filesystem.upload(projectId, currentPath, files)
                    qc.invalidateQueries({ queryKey: ['files', projectId] })
                    toast.success(`Uploaded ${res.files.length} file(s)`)
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Upload failed')
                  }
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        )}
      </div>

      {/* ── Right panel: file detail ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <FileDetailPanel
            projectId={projectId}
            file={selectedFile}
            content={editorContent}
            isDirty={isDirty}
            isSaving={writeMutation.isPending}
            onContentChange={(v) => { setEditorContent(v); setIsDirty(true) }}
            onSave={handleSave}
            onDelete={() => deleteMutation.mutate(selectedFile.path)}
            onClose={() => { setSelectedFile(null); setIsDirty(false) }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            <div className="text-center space-y-2">
              <FileText className="w-8 h-8 mx-auto text-muted-foreground/40" />
              <p>Select a file to view</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
