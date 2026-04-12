import { z } from 'zod'
import type { ToolDefinition, ToolStreamChunk } from '@jiku/types'
import { getFilesystemService } from './factory.ts'

/**
 * Build filesystem tools for a project.
 * Returns empty array if filesystem is not enabled/configured.
 * Called from RuntimeManager.wakeUp() after checking filesystem config.
 */
const FS_HINT =
  'Use filesystem tools ONLY when the user explicitly asks to create, read, or manage a file, ' +
  'or when the task inherently involves persisting data to disk (e.g. generating a report file, ' +
  'saving a document). For all other requests, respond directly in the conversation — do NOT save ' +
  'output to a file unless the user specifically wants one.'

export function buildFilesystemTools(projectId: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      meta: {
        id: 'fs_list',
        name: 'fs_list',
        description: 'List files and folders at a given path in the project filesystem',
        group: 'filesystem',
      },
      prompt: FS_HINT,
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
      prompt: FS_HINT,
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
          // Plan 16: read() now returns { content, version, cached }
          const result = await fs.read(path)
          return { path, content: result.content, version: result.version, cached: result.cached }
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
      prompt: FS_HINT,
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
      prompt: FS_HINT,
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
      prompt: FS_HINT,
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
      prompt: FS_HINT,
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
