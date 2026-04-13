// Browser adapter abstraction for Jiku Studio's multi-profile browser system.
//
// Each `BrowserAdapter` implementation can register itself (built-in via
// direct registry calls, or via plugin `ctx.browser.register(adapter)`) and
// becomes available to users when creating a Browser Profile.

import type { ToolDefinition } from '@jiku/types'

// Minimal Zod-compatible schema shape — avoids a hard dep on zod in @jiku/kit.
// Any real zod `ZodObject` will satisfy this.
export interface BrowserAdapterConfigSchema {
  parse(data: unknown): unknown
  safeParse(data: unknown): { success: boolean; data?: unknown; error?: unknown }
}

export interface BrowserAdapterContext {
  /** Unique ID of the browser profile the call is routed to. */
  profileId: string
  /** Project that owns the profile. */
  projectId: string
  /** Agent making the call (may be absent for server-side invocations). */
  agentId?: string
  /** Resolved, validated config for the profile. Adapter-specific shape. */
  config: unknown
}

export interface BrowserAdapterTextPart {
  type: 'text'
  text: string
}

export interface BrowserAdapterImagePart {
  type: 'image'
  /** Base64-encoded image payload. */
  data?: string
  /** Attachment reference when persisted to storage. */
  attachment_id?: string
  storage_key?: string
  mime_type?: string
  mimeType?: string
}

export type BrowserAdapterContentPart = BrowserAdapterTextPart | BrowserAdapterImagePart

export interface BrowserAdapterResult {
  content: BrowserAdapterContentPart[]
  details?: unknown
}

export interface BrowserPingResult {
  ok: boolean
  latency_ms?: number
  browser?: string
  cdp_url?: string
  error?: string
}

/**
 * A platform-specific action exposed by an adapter beyond the shared
 * `BrowserAction` enum. Surfaces via the `browser_list_actions` tool so LLMs
 * can discover what an adapter can do, and invokes via `browser_run_action`.
 */
export interface BrowserCustomAction {
  /** Stable action id, unique within the adapter (e.g. "youtube_transcript"). */
  id: string
  /** Short human-readable label for UI / discovery output. */
  displayName: string
  /** One-paragraph description shown to the LLM in `browser_list_actions`. */
  description: string
  /**
   * Zod-compatible schema for the action's params. Used to validate input on
   * the server and to show a JSON-schema hint to the LLM. Pass a real
   * `ZodObject` — it already satisfies this shape.
   */
  inputSchema?: BrowserAdapterConfigSchema
  /** Optional example params for the discovery output. */
  example?: Record<string, unknown>
}

export interface BrowserPreviewResult {
  ok: boolean
  data?: {
    base64: string
    format: 'png' | 'jpeg'
    title?: string | null
    url?: string | null
  }
  error?: string
  hint?: string | null
}

/**
 * Abstract base class for browser adapters.
 *
 * A browser adapter implements the contract between a Jiku Browser Profile
 * (row in `browser_profiles`) and the concrete browser backend (e.g. CDP
 * endpoint, CamoFox, etc.). Register via:
 *   - Built-in:   `browserAdapterRegistry.register(adapter)` at server start.
 *   - Plugin:     `ctx.browser.register(adapter)` inside the plugin setup.
 */
export abstract class BrowserAdapter {
  /** Unique adapter ID — kebab.dot format, e.g. 'jiku.browser.vercel'. */
  abstract readonly id: string

  /** Short display name shown in the adapter selector UI. */
  abstract readonly displayName: string

  /** One-paragraph description explaining what this adapter does. */
  abstract readonly description: string

  /** Schema for adapter-specific profile config. */
  abstract readonly configSchema: BrowserAdapterConfigSchema

  /**
   * Execute a browser action for an agent.
   * Receives the resolved, validated config from the profile.
   */
  abstract execute(
    input: unknown,
    ctx: BrowserAdapterContext,
  ): Promise<BrowserAdapterResult>

  /** Test connectivity with the given profile config. */
  abstract ping(config: unknown): Promise<BrowserPingResult>

  /** Capture a one-shot preview screenshot. */
  abstract preview(config: unknown): Promise<BrowserPreviewResult>

  /** Optional adapter-specific extra tools, added to agents whenever a profile
   *  using this adapter is active in the project. */
  additionalTools?(): ToolDefinition[]

  /**
   * Platform-specific actions the adapter exposes beyond the shared
   * `BrowserAction` enum. LLMs discover these via the `browser_list_actions`
   * tool and invoke them via `browser_run_action`.
   */
  readonly customActions?: readonly BrowserCustomAction[]

  /**
   * Execute a custom action by id. Called by the `browser_run_action` tool.
   * Must be implemented if `customActions` is non-empty.
   */
  runCustomAction?(
    actionId: string,
    params: unknown,
    ctx: BrowserAdapterContext,
  ): Promise<BrowserAdapterResult>

  /** Called when a profile using this adapter is activated / deactivated. */
  onProfileActivated?(profileId: string, config: unknown): Promise<void>
  onProfileDeactivated?(profileId: string): Promise<void>
}

export function defineBrowserAdapter<T extends BrowserAdapter>(adapter: T): T {
  return adapter
}
