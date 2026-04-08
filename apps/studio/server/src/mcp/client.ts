import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDefinition } from '@jiku/types'
import { wrapMCPTool } from './wrapper.ts'

export interface MCPServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  config: {
    url?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    headers?: Record<string, string>
  }
}

interface ConnectedServer {
  client: Client
  tools: ToolDefinition[]
  config: MCPServerConfig
}

class MCPClientManager {
  private servers = new Map<string, ConnectedServer>()

  /** Connect to an MCP server and fetch its tool list. */
  async connect(serverConfig: MCPServerConfig): Promise<void> {
    // Disconnect existing connection if any
    if (this.servers.has(serverConfig.id)) {
      await this.disconnect(serverConfig.id)
    }

    const client = new Client({ name: 'jiku-studio', version: '1.0.0' })

    let transport
    switch (serverConfig.transport) {
      case 'stdio':
        transport = new StdioClientTransport({
          command: serverConfig.config.command ?? '',
          args: serverConfig.config.args ?? [],
          env: serverConfig.config.env,
        })
        break
      case 'sse':
        transport = new SSEClientTransport(
          new URL(serverConfig.config.url ?? 'http://localhost:3001/sse'),
        )
        break
      case 'streamable-http':
        transport = new StreamableHTTPClientTransport(
          new URL(serverConfig.config.url ?? 'http://localhost:3001/mcp'),
        )
        break
      default:
        throw new Error(`Unsupported MCP transport: ${serverConfig.transport}`)
    }

    // Connect with 5-second timeout
    const connectPromise = client.connect(transport)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP connect timeout: ${serverConfig.name}`)), 5000)
    )
    await Promise.race([connectPromise, timeoutPromise])

    // Fetch tools
    const toolsResult = await client.listTools()
    const tools: ToolDefinition[] = (toolsResult.tools ?? []).map(mcpTool =>
      wrapMCPTool(serverConfig.id, serverConfig.name, mcpTool, client)
    )

    this.servers.set(serverConfig.id, { client, tools, config: serverConfig })
  }

  /** Disconnect from an MCP server. */
  async disconnect(serverId: string): Promise<void> {
    const server = this.servers.get(serverId)
    if (server) {
      try {
        await server.client.close()
      } catch {
        // Ignore close errors
      }
      this.servers.delete(serverId)
    }
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.servers.keys()).map(id => this.disconnect(id))
    await Promise.allSettled(promises)
  }

  /** Get tools from a specific server. */
  getServerTools(serverId: string): ToolDefinition[] {
    return this.servers.get(serverId)?.tools ?? []
  }

  /** Get all tools from all connected servers. */
  getAllTools(): ToolDefinition[] {
    const allTools: ToolDefinition[] = []
    for (const server of this.servers.values()) {
      allTools.push(...server.tools)
    }
    return allTools
  }

  /** Get tools for a specific project/agent context. */
  getToolsForAgent(serverConfigs: MCPServerConfig[]): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    for (const cfg of serverConfigs) {
      const server = this.servers.get(cfg.id)
      if (server) {
        tools.push(...server.tools)
      }
    }
    return tools
  }

  /** Check if a server is connected. */
  isConnected(serverId: string): boolean {
    return this.servers.has(serverId)
  }

  /** Get connection status for all known servers. */
  getStatus(): Array<{ id: string; name: string; connected: boolean; toolCount: number }> {
    return Array.from(this.servers.values()).map(s => ({
      id: s.config.id,
      name: s.config.name,
      connected: true,
      toolCount: s.tools.length,
    }))
  }
}

export const mcpManager = new MCPClientManager()
