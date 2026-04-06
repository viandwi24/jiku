import { z } from 'zod'
import type { ToolDefinition } from '@jiku/types'
import { getFilesystemService } from './service.ts'

/**
 * Build filesystem tools for a project.
 * Returns empty array if filesystem is not enabled/configured.
 * Called from RuntimeManager.wakeUp() after checking filesystem config.
 */
export function buildFilesystemTools(projectId: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      meta: {
        id: 'fs_list',
        name: 'fs_list',
        description: 'List files and folders at a given path in the project filesystem',
        group: 'filesystem',
      },
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
          const content = await fs.read(path)
          return { path, content }
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
      permission: 'fs:write',
      modes: ['chat', 'task'],
      input: z.object({
        path: z.string().describe("Full file path, e.g. '/src/utils/helper.ts'"),
        content: z.string().describe('File content to write'),
      }),
      execute: async (args: unknown) => {
        const { path, content } = args as { path: string; content: string }
        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem is not configured for this project' }
        try {
          const file = await fs.write(path, content)
          return { success: true, path: file.path, size_bytes: file.size_bytes }
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
    },
  ]

  return tools
}
