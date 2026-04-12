import { z } from 'zod'
import type { ToolDefinition, ToolStreamChunk } from '@jiku/types'
import { getFilesystemService } from './factory.ts'

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
  'Use fs_write / fs_move / fs_delete ONLY when the user explicitly asks to save, move, or delete ' +
  'a file, or when the task inherently requires persisting output to disk (e.g. "save this as a report"). ' +
  'For all other responses, reply in the conversation — do NOT write files unless asked.'

/**
 * Per-extension hints injected into fs_read when a binary file is detected.
 * Populated by the runtime manager from the active plugin registry so that
 * agents are told about the right specialised tool for each file type.
 * Key: lowercase extension without dot (e.g. "xlsx"). Value: human-readable hint.
 */
export type BinaryFileHints = Map<string, string>

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
        description: 'Read the content of a file from the project filesystem',
        group: 'filesystem',
      },
      prompt: FS_READ_HINT,
      permission: 'fs:read',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/src/index.ts'"),
      }),
      execute: async (args: unknown) => {
        const { path } = args as { path: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const result = await fs.read(path)
          const content: string = result.content

          // Binary files are stored with a __b64__: prefix.
          // Returning large base64 blobs to the model wastes context tokens and
          // can exceed the context window entirely. We intercept here and return
          // structured metadata + a tool hint instead.
          if (content.startsWith('__b64__:')) {
            const ext       = path.split('.').pop()?.toLowerCase() ?? ''
            const base64    = content.slice('__b64__:'.length)
            // Base64 is ~4/3 of the binary size, so decoded ≈ base64.length * 0.75
            const approxBytes = Math.round(base64.length * 0.75)
            const approxKB    = Math.round(approxBytes / 1024)

            // Check if a specialised tool is registered for this extension.
            // binaryHints is populated by the runtime manager from the active plugin registry.
            const specialisedTool = binaryHints?.get(ext)

            if (specialisedTool) {
              // Always block raw binary when a dedicated tool exists — the tool
              // knows how to handle the file efficiently without blowing context.
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

            // No specialised tool — return content only if small enough.
            // Threshold: 256 KB decoded (~340 KB base64 / ~85 K tokens).
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

            // Small binary with no dedicated tool — return as-is.
            // (Useful for small images passed to vision-capable models, etc.)
            return { path, content, version: result.version, cached: result.cached }
          }

          return { path, content, version: result.version, cached: result.cached }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'File not found' }
        }
      },
    },

    {
      meta: {
        id: 'fs_write',
        name: 'fs_write',
        description: "Write content to a file in the project filesystem. Creates the file if it doesn't exist, overwrites if it does.",
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/src/utils/helper.ts'"),
        content: z.string().describe('File content to write'),
        expected_version: z.number().int().optional().describe(
          'Optimistic lock. Pass the version value from a previous fs_read response. ' +
          'If the file was modified since, the write will be rejected with a conflict error.',
        ),
      }),
      execute: async (args: unknown) => {
        const { path, content, expected_version } = args as { path: string; content: string; expected_version?: number }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const file = await fs.write(path, content, { expectedVersion: expected_version })
          return { success: true, path: file.path, size_bytes: file.size_bytes, version: file.version }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Write failed' }
        }
      },
    },

    {
      meta: {
        id: 'fs_move',
        name: 'fs_move',
        description: 'Move or rename a file in the project filesystem',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        from: z.string().describe('Current file path'),
        to: z.string().describe('New file path'),
      }),
      execute: async (args: unknown) => {
        const { from, to } = args as { from: string; to: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          await fs.move(from, to)
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
        description: 'Delete a file from the project filesystem',
        group: 'filesystem',
      },
      prompt: FS_WRITE_HINT,
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe('File path to delete'),
      }),
      execute: async (args: unknown) => {
        const { path } = args as { path: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          await fs.delete(path)
          return { success: true, path }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Delete failed' }
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
      // Plan 15.1: Streaming search — yields progress per batch of matches
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
