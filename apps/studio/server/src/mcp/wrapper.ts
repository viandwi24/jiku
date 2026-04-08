import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool as MCPToolSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition } from '@jiku/types'

/**
 * Wrap an MCP tool definition into a Jiku ToolDefinition.
 * The tool's execute function calls the MCP server via the client.
 */
export function wrapMCPTool(
  serverId: string,
  serverName: string,
  mcpTool: MCPToolSchema,
  client: Client,
): ToolDefinition {
  // Sanitize tool name for LLM compatibility
  const toolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, '_')

  return {
    meta: {
      id: `mcp_${serverId}_${toolName}`,
      name: mcpTool.name,
      description: mcpTool.description ?? `Tool from MCP server: ${serverName}`,
      group: 'mcp',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: mcpTool.inputSchema ?? {},
    execute: async (args: unknown) => {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: (args ?? {}) as Record<string, unknown>,
      })

      // Extract text content from MCP result
      if (result.content && Array.isArray(result.content)) {
        const texts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text)

        if (texts.length === 1) return texts[0]
        if (texts.length > 1) return texts.join('\n')
      }

      return result.content ?? result
    },
  }
}
