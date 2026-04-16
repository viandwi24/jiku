import { z } from 'zod'
import type { ToolDefinition, ToolStreamChunk, ToolContext } from '@jiku/types'
import { getFilesystemService } from './factory.ts'
import { recordFsRead, getFsRead, forgetFsRead, forgetFsReadsUnderPrefix, getFileByPath, getFolderByPath, resolveFsToolPermission } from '@jiku-studio/db'
import { audit } from '../audit/logger.ts'

/**
 * Build filesystem tools for a project.
 * Returns empty array if filesystem is not enabled/configured.
 * Called from RuntimeManager.wakeUp() after checking filesystem config.
 */
// Shown when read/search tools are available.
// Key rule: check the disk FIRST before ever asking the user to upload or provide a file.
const FS_READ_HINT =
  'The project has a disk (filesystem). Files the user refers to — spreadsheets, documents, ' +
  'images, data files — are often already there.\n' +
  'RULE: When the user asks you to read, analyse, or do anything with a file, ALWAYS check the ' +
  'disk first using fs_search or fs_list BEFORE asking them to upload or provide a path. ' +
  'If you find a matching file, proceed with it directly and tell the user which file you are using. ' +
  'Only ask the user for a file if the disk search comes up empty.'

// Shown when write/mutate tools are available.
// Key rule: do NOT write to disk unless the user explicitly wants a file saved.
const FS_WRITE_HINT =
  'Use fs_write / fs_edit / fs_move / fs_delete ONLY when the user explicitly asks to save, ' +
  'modify, move, or delete a file, or when the task inherently requires persisting output to disk. ' +
  'For all other responses, reply in the conversation — do NOT write files unless asked.\n\n' +
  'READ-BEFORE-WRITE: fs_write and fs_edit require that you have fs_read the file earlier in this ' +
  'conversation. Exception: fs_write for a brand-new file (path does not exist yet) is allowed ' +
  'without a prior read. If the file was modified externally since your last read, the tool will ' +
  'return STALE_FILE_STATE — call fs_read again to re-sync, then retry.\n\n' +
  'TOOL CHOICE:\n' +
  '  • fs_append — for append-only workflows (growing logs, message journals, event streams). ' +
  'Cheapest, no read required, no anchor needed.\n' +
  '  • fs_edit   — for partial changes to existing files (substring replacement). Requires prior fs_read.\n' +
  '  • fs_write  — for brand-new files or full rewrites. For existing files, requires prior fs_read ' +
  'and sends the whole content — wasteful for small edits.'

/**
 * Per-extension hints injected into fs_read when a binary file is detected.
 * Populated by the runtime manager from the active plugin registry so that
 * agents are told about the right specialised tool for each file type.
 * Key: lowercase extension without dot (e.g. "xlsx"). Value: human-readable hint.
 */
export type BinaryFileHints = Map<string, string>

/**
 * Plan 26 — FS tool permission gate. Returns null if OK, else an error payload
 * the tool should return verbatim to the model. Applies only to mutating ops
 * (write / edit / append / move / delete). Read ops are always allowed.
 */
async function checkToolPermGate(
  projectId: string,
  path: string,
  operation: 'write' | 'edit' | 'append' | 'move' | 'delete',
  caller?: { user_id?: string | null; agent_id?: string | null },
): Promise<{ error: string; code: 'FS_TOOL_READONLY'; hint: string } | null> {
  const resolved = await resolveFsToolPermission(projectId, path)
  if (resolved.effective === 'read+write') return null
  const sourceDesc = resolved.source === 'self'
    ? `this path is marked read-only for tools`
    : `inherited read-only from "${resolved.source_path ?? '/'}"`
  audit.fsPermissionDenied(
    { actor_id: caller?.user_id ?? null, actor_type: caller?.agent_id ? 'agent' : 'system', project_id: projectId },
    path,
    { operation, effective_permission: resolved.effective, source_path: resolved.source_path, agent_id: caller?.agent_id ?? null },
  )
  return {
    error: `Access denied: ${path} — ${sourceDesc}. fs_${operation} is blocked.`,
    code: 'FS_TOOL_READONLY',
    hint: resolved.source === 'inherited'
      ? `The read-only flag is set on "${resolved.source_path}". Write elsewhere, or ask the user to flip the permission in the Disk explorer.`
      : 'Write to a path under a read+write folder, or ask the user to change this file\'s tool permission.',
  }
}

/**
 * Claude-Code-style read-before-write gate.
 * Returns null if OK to proceed, otherwise returns an error payload the tool
 * should return to the model verbatim.
 */
async function checkReadGate(
  projectId: string,
  conversationId: string | null | undefined,
  path: string,
  opts: { allowMissingRead: boolean },
): Promise<{ error: string; code: 'MUST_READ_FIRST' | 'STALE_FILE_STATE'; hint?: string } | null> {
  if (!conversationId) return null // no conversation context → skip gate (e.g. cron)

  const current = await getFileByPath(projectId, path)
  const tracked = await getFsRead(conversationId, path)

  if (!tracked) {
    if (opts.allowMissingRead && !current) return null // new-file create
    return {
      code: 'MUST_READ_FIRST',
      error: `MUST_READ_FIRST: file "${path}" has not been fs_read in this conversation yet. Call fs_read first, then retry.`,
      hint: 'Claude-Code-style safety: you must observe a file before mutating it.',
    }
  }

  if (current && current.version !== tracked.version) {
    return {
      code: 'STALE_FILE_STATE',
      error: `STALE_FILE_STATE: file "${path}" was modified externally since your last fs_read (you saw v${tracked.version}, now v${current.version}). Call fs_read again to re-sync, then retry.`,
    }
  }

  // File was tracked but has been deleted on disk — allow write (creates new).
  return null
}

export function buildFilesystemTools(projectId: string, binaryHints?: BinaryFileHints): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      meta: {
        id: 'fs_list',
        name: 'fs_list',
        description: 'List files and folders at a given path in the project filesystem',
        group: 'filesystem',
      },
      prompt: FS_READ_HINT,
      permission: 'fs:read',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().default('/').describe("Folder path to list. Default: '/'"),
      }),
      execute: async (args: unknown) => {
        const { path } = args as { path: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const entries = await fs.list(path)
          return { entries, count: entries.length }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to list files' }
        }
      },
    },

    {
      meta: {
        id: 'fs_read',
        name: 'fs_read',
        description:
          'Read a file from the project filesystem. Supports line-range reads via `offset` + `limit`. ' +
          'For large files the response is truncated to the first 2000 lines (configurable) and long ' +
          'lines are truncated to 2000 chars — a hint in the response tells you how to page through. ' +
          'Content is returned in `cat -n` format (each line prefixed with its 1-based line number), ' +
          'so you can reference exact line numbers in fs_edit `old_string` anchors. ' +
          'Always fs_read a file before fs_write or fs_edit — the session read-tracker uses it to ' +
          'enforce read-before-write and to detect external modification (STALE_FILE_STATE).',
        group: 'filesystem',
      },
      prompt: FS_READ_HINT,
      permission: 'fs:read',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/src/index.ts'"),
        offset: z.number().int().min(1).optional().describe(
          '1-based line number to start reading from. Default: 1 (beginning).',
        ),
        limit: z.number().int().min(1).max(5000).optional().describe(
          'Maximum number of lines to return. Default: 2000. Cap: 5000.',
        ),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { path, offset: rawOffset, limit: rawLimit } = args as {
          path: string; offset?: number; limit?: number
        }
        const conversationId = ctx?.runtime?.conversation_id
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const result = await fs.read(path)
          const content: string = result.content

          // Register the read in the session tracker so subsequent writes/edits
          // are allowed and can detect staleness.
          if (conversationId) {
            const file = await getFileByPath(projectId, path)
            if (file) {
              await recordFsRead({
                conversation_id: conversationId,
                path,
                version: file.version,
                content_hash: file.content_hash ?? null,
              })
            }
          }

          // Binary files are stored with a __b64__: prefix.
          if (content.startsWith('__b64__:')) {
            const ext       = path.split('.').pop()?.toLowerCase() ?? ''
            const base64    = content.slice('__b64__:'.length)
            const approxBytes = Math.round(base64.length * 0.75)
            const approxKB    = Math.round(approxBytes / 1024)

            const specialisedTool = binaryHints?.get(ext)

            if (specialisedTool) {
              return {
                path,
                type: 'binary',
                extension: ext,
                size_kb: approxKB,
                content: null,
                note:
                  `This is a binary .${ext} file (${approxKB} KB). ` +
                  `Do NOT read its raw content — use the specialised tool instead: ${specialisedTool}. ` +
                  `Example: ${specialisedTool}({ path: "${path}" })`,
                suggested_tool: specialisedTool,
              }
            }

            const MAX_BINARY_BYTES = 256 * 1024
            if (approxBytes > MAX_BINARY_BYTES) {
              return {
                path,
                type: 'binary',
                extension: ext,
                size_kb: approxKB,
                content: null,
                note:
                  `This binary .${ext} file is too large to read directly (${approxKB} KB). ` +
                  `Reading it would overflow the model context window. ` +
                  `Check if a specialised tool exists for .${ext} files, ` +
                  `or ask the user to provide the file in a text-readable format.`,
              }
            }

            return { path, content, version: result.version, cached: result.cached }
          }

          // Text file — paginate + line-number prefix + per-line truncation.
          const MAX_LIMIT = 5000
          const DEFAULT_LIMIT = 2000
          const MAX_LINE_CHARS = 2000
          const lines = content.split('\n')
          const totalLines = lines.length
          const offset = Math.max(1, rawOffset ?? 1)
          const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const startIdx = Math.min(offset - 1, totalLines)
          const endIdx = Math.min(startIdx + limit, totalLines)
          const slice = lines.slice(startIdx, endIdx)

          let longLinesTruncated = 0
          const padWidth = String(endIdx).length
          const formatted = slice.map((ln, i) => {
            const lineNo = startIdx + i + 1
            let rendered = ln
            if (ln.length > MAX_LINE_CHARS) {
              rendered = ln.slice(0, MAX_LINE_CHARS) + `  …[+${ln.length - MAX_LINE_CHARS} chars truncated]`
              longLinesTruncated++
            }
            return `${String(lineNo).padStart(padWidth, ' ')}\t${rendered}`
          }).join('\n')

          const truncated = endIdx < totalLines
          const hints: string[] = []
          if (truncated) {
            hints.push(
              `File has ${totalLines} lines; showing ${startIdx + 1}-${endIdx}. ` +
              `To see more: fs_read({ path: "${path}", offset: ${endIdx + 1}, limit: ${limit} }).`,
            )
          }
          if (longLinesTruncated > 0) {
            hints.push(`${longLinesTruncated} line(s) were truncated at ${MAX_LINE_CHARS} chars.`)
          }

          return {
            path,
            content: formatted,
            version: result.version,
            cached: result.cached,
            start_line: slice.length > 0 ? startIdx + 1 : 0,
            end_line: endIdx,
            total_lines: totalLines,
            truncated,
            ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'File not found' }
        }
      },
    },

    {
      meta: {
        id: 'fs_write',
        name: 'fs_write',
        description:
          "Write (overwrite) content to a file in the project filesystem. Creates the file if " +
          "it doesn't exist. For modifying part of an existing file, PREFER fs_edit. " +
          "REQUIRES a prior fs_read in this conversation, except when creating a brand-new file.",
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/src/utils/helper.ts'"),
        content: z.string().describe('File content to write'),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { path, content } = args as { path: string; content: string }
        const conversationId = ctx?.runtime?.conversation_id
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }

        const permGate = await checkToolPermGate(projectId, path, 'write', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGate) return permGate

        const gate = await checkReadGate(projectId, conversationId, path, { allowMissingRead: true })
        if (gate) return gate

        try {
          // Pass the tracked version as expected_version so the backend's
          // optimistic lock gives a second line of defence.
          const tracked = conversationId ? await getFsRead(conversationId, path) : null
          const file = await fs.write(path, content, {
            expectedVersion: tracked?.version,
          })
          // Refresh tracker with the new version so subsequent edits are allowed.
          if (conversationId) {
            await recordFsRead({
              conversation_id: conversationId,
              path,
              version: file.version,
              content_hash: file.content_hash ?? null,
            })
          }
          return { success: true, path: file.path, size_bytes: file.size_bytes, version: file.version }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Write failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_edit',
        name: 'fs_edit',
        description:
          'Edit a file by replacing a specific substring. Preferred over fs_write for partial ' +
          'changes — saves tokens and preserves the rest of the file verbatim. ' +
          '`old_string` must appear EXACTLY ONCE in the file unless `replace_all` is true. ' +
          'IMPORTANT: fs_read returns content in `cat -n` format (each line prefixed with a line ' +
          'number + tab). Do NOT include those line-number prefixes in `old_string` / `new_string` — ' +
          'match against the raw file content only. ' +
          'REQUIRES a prior fs_read of the file in this conversation. If the file was modified ' +
          'externally since your last read, returns STALE_FILE_STATE — re-read and retry.',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/src/utils/helper.ts'"),
        old_string: z.string().describe(
          'The exact text to replace. Include enough surrounding context to make it unique in ' +
          'the file (indentation, neighbouring lines) unless you set replace_all.',
        ),
        new_string: z.string().describe('The replacement text. May be empty string to delete.'),
        replace_all: z.boolean().default(false).describe(
          'If true, replace every occurrence of old_string. If false (default), old_string must ' +
          'appear exactly once.',
        ),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { path, old_string, new_string, replace_all } = args as {
          path: string; old_string: string; new_string: string; replace_all: boolean
        }
        const conversationId = ctx?.runtime?.conversation_id
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }

        if (old_string === new_string) {
          return { error: 'old_string and new_string are identical — nothing to change.' }
        }

        const permGate = await checkToolPermGate(projectId, path, 'edit', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGate) return permGate

        const gate = await checkReadGate(projectId, conversationId, path, { allowMissingRead: false })
        if (gate) return gate

        try {
          const existing = await fs.read(path)
          const content: string = existing.content

          if (content.startsWith('__b64__:')) {
            return { error: 'fs_edit cannot modify binary files. Use a specialised tool or fs_write.' }
          }

          // Count occurrences
          let occurrences = 0
          let idx = content.indexOf(old_string)
          while (idx !== -1) {
            occurrences++
            idx = content.indexOf(old_string, idx + old_string.length)
          }

          if (occurrences === 0) {
            return {
              error: `old_string not found in "${path}". The file may have changed, or the snippet doesn't match exactly (check whitespace/indentation). fs_read the file again and retry.`,
            }
          }
          if (occurrences > 1 && !replace_all) {
            return {
              error: `old_string appears ${occurrences} times in "${path}" — ambiguous. Either add more surrounding context to make it unique, or pass replace_all: true.`,
              occurrences,
            }
          }

          const updated = replace_all
            ? content.split(old_string).join(new_string)
            : content.replace(old_string, new_string)

          const tracked = conversationId ? await getFsRead(conversationId, path) : null
          const file = await fs.write(path, updated, { expectedVersion: tracked?.version })

          if (conversationId) {
            await recordFsRead({
              conversation_id: conversationId,
              path,
              version: file.version,
              content_hash: file.content_hash ?? null,
            })
          }

          return {
            success: true,
            path: file.path,
            replaced: replace_all ? occurrences : 1,
            size_bytes: file.size_bytes,
            version: file.version,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Edit failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_append',
        name: 'fs_append',
        description:
          'Append content to the end of a file. Creates the file if it does not exist. ' +
          'DOES NOT require a prior fs_read — append is purely additive, no chance of clobber. ' +
          'Prefer this over fs_write / fs_edit for append-only workflows (message journals, logs, ' +
          'event streams, incremental report generation) — saves a lot of tokens on large files. ' +
          'After append, any prior session read-tracker entry for this path is cleared, so if you ' +
          'later want to fs_edit the file you must fs_read it again first.',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/logs/events.jsonl'"),
        content: z.string().describe('Content to append. Include your own trailing newline if you want line-delimited entries.'),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { path, content } = args as { path: string; content: string }
        const conversationId = ctx?.runtime?.conversation_id
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }

        const permGate = await checkToolPermGate(projectId, path, 'append', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGate) return permGate

        try {
          let combined: string
          let previousSize = 0
          const existing = await getFileByPath(projectId, path)
          if (existing) {
            // Read current content server-side (no model token cost) and
            // concatenate. For very large files this still loads into memory —
            // acceptable for our S3 text-file size cap (5 MB).
            const current = await fs.read(path)
            if (current.content.startsWith('__b64__:')) {
              return { error: 'fs_append cannot append to binary files.' }
            }
            previousSize = Buffer.byteLength(current.content, 'utf-8')
            combined = current.content + content
          } else {
            combined = content
          }

          const file = await fs.write(path, combined)

          // Invalidate any stale tracker — the agent hasn't observed the new
          // tail, so force a re-read before any future fs_edit / fs_write.
          if (conversationId) await forgetFsRead(conversationId, path)

          return {
            success: true,
            path: file.path,
            appended_bytes: Buffer.byteLength(content, 'utf-8'),
            previous_size_bytes: previousSize,
            size_bytes: file.size_bytes,
            version: file.version,
            created: !existing,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Append failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_move',
        name: 'fs_move',
        description: 'Move or rename a file OR folder in the project filesystem. For folders, every descendant file + nested folder is rewritten in a single atomic transaction. Cannot move root `/`. Cannot move a folder into its own descendant.',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        from: z.string().describe('Current path (file or folder)'),
        to: z.string().describe('New path. Include the basename (e.g. for rename use the same parent folder; for move use a new parent folder).'),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { from, to } = args as { from: string; to: string }
        const conversationId = ctx?.runtime?.conversation_id
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }

        const permGateFrom = await checkToolPermGate(projectId, from, 'move', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGateFrom) return permGateFrom
        const permGateTo = await checkToolPermGate(projectId, to, 'move', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGateTo) return permGateTo

        try {
          await fs.move(from, to)
          // Tracker rows are keyed by path — drop the old path. For folder
          // moves, also drop any tracker row whose path begins with the old
          // folder, otherwise descendant files would be marked stale on the
          // next mutate even though we just moved them.
          if (conversationId) {
            await forgetFsRead(conversationId, from)
            await forgetFsReadsUnderPrefix(conversationId, from)
          }
          return { success: true, from, to }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Move failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_delete',
        name: 'fs_delete',
        description:
          'Delete a file OR folder from the project filesystem. For folders, set `recursive: true` to delete the folder + ALL descendants — without it, folder deletes are rejected (safety guard against accidental wipes). File deletes ignore `recursive`.',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe('Path to delete (file or folder)'),
        recursive: z.boolean().optional().describe('Required when deleting a folder. Confirms you want to wipe everything under it.'),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { path, recursive } = args as { path: string; recursive?: boolean }
        const conversationId = ctx?.runtime?.conversation_id
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }

        const permGate = await checkToolPermGate(projectId, path, 'delete', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGate) return permGate

        try {
          // Detect file vs folder. Try file first — if missing, try folder.
          const file = await getFileByPath(projectId, path)
          if (file) {
            await fs.delete(path)
            if (conversationId) await forgetFsRead(conversationId, path)
            return { success: true, path, type: 'file' }
          }
          const folderRow = await getFolderByPath(projectId, path)
          if (!folderRow) return { error: `Path not found: ${path}` }
          if (!recursive) {
            return {
              error: `Path "${path}" is a folder. Pass { recursive: true } to delete it and ALL descendants. This is a safety guard.`,
              code: 'FOLDER_DELETE_REQUIRES_RECURSIVE',
            }
          }
          const deleted = await fs.deleteFolder(path)
          if (conversationId) {
            await forgetFsRead(conversationId, path)
            await forgetFsReadsUnderPrefix(conversationId, path)
          }
          return { success: true, path, type: 'folder', deleted_files: deleted }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Delete failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_mkdir',
        name: 'fs_mkdir',
        description: 'Create an empty folder in the project filesystem. Idempotent — succeeds even if the folder already exists. Intermediate ancestor folders are created automatically. Folders are normally created implicitly by fs_write — call this only when you need an EMPTY folder.',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Folder path, e.g. '/reports/2026-04'. Must start with '/' and not be the root."),
      }),
      execute: async (args: unknown, ctx: ToolContext) => {
        const { path } = args as { path: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }

        const permGate = await checkToolPermGate(projectId, path, 'write', { user_id: ctx?.caller?.user_id, agent_id: ctx?.runtime?.agent_id })
        if (permGate) return permGate

        try {
          await fs.mkdir(path)
          return { success: true, path }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'mkdir failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_search',
        name: 'fs_search',
        description: 'Search files by name or path pattern in the project filesystem',
        group: 'filesystem',
      },
      prompt: FS_READ_HINT,
      permission: 'fs:read',
      modes: ['chat', 'task'],
      input: z.object({
        query: z.string().describe('Search query — matches file name or path'),
        extension: z.string().optional().describe("Filter by extension, e.g. '.ts'"),
      }),
      execute: async (args: unknown) => {
        const { query, extension } = args as { query: string; extension?: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const files = await fs.search(query, extension)
          return {
            files: files.map(f => ({ path: f.path, name: f.name, size_bytes: f.size_bytes, updated_at: f.updated_at })),
            count: files.length,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Search failed' }
        }
      },
      async *executeStream(args: unknown): AsyncGenerator<ToolStreamChunk, unknown> {
        const { query, extension } = args as { query: string; extension?: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const files = await fs.search(query, extension)
          const BATCH = 5
          for (let i = 0; i < files.length; i += BATCH) {
            const batch = files.slice(i, i + BATCH)
            yield {
              type: 'progress',
              data: {
                found: batch.map(f => f.path),
                total_so_far: Math.min(i + BATCH, files.length),
                total: files.length,
              },
            }
          }
          return {
            files: files.map(f => ({ path: f.path, name: f.name, size_bytes: f.size_bytes, updated_at: f.updated_at })),
            count: files.length,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Search failed' }
        }
      },
    },
  ]

  return tools
}
