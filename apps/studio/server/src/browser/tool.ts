import type { ToolDefinition, ToolContext } from '@jiku/types'
import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import { getProjectBrowserProfiles } from '@jiku-studio/db'
import { BrowserToolInputSchema, type BrowserToolInput } from './tool-schema.ts'
import { browserAdapterRegistry } from './adapter-registry.ts'
import type { BrowserProfile } from '@jiku-studio/db'

/**
 * Plan 20 — Build the unified browser tool for a project.
 *
 * A project can have N browser profiles, each pinned to an adapter. The tool
 * exposes all of them through a single `browser` tool with an optional
 * `profile_id` argument. If omitted, the call routes to the profile marked
 * `is_default`. Adapters may also contribute `additionalTools()` that are
 * exposed alongside the unified tool.
 */
export async function buildBrowserTools(projectId: string): Promise<ToolDefinition[]> {
  const profiles = await getProjectBrowserProfiles(projectId)
  const activeProfiles = profiles.filter(p => p.enabled)
  if (activeProfiles.length === 0) return []

  const defaultProfile = activeProfiles.find(p => p.is_default) ?? activeProfiles[0]!

  // Collect adapter-specific extra tools, once per distinct adapter.
  const seen = new Set<string>()
  const additionalTools: ToolDefinition[] = []
  for (const profile of activeProfiles) {
    if (seen.has(profile.adapter_id)) continue
    seen.add(profile.adapter_id)
    const adapter = browserAdapterRegistry.get(profile.adapter_id)
    const extra = adapter?.additionalTools?.() ?? []
    additionalTools.push(...extra)
  }

  const profileListText = activeProfiles
    .map(p => `"${p.name}" (profile_id: "${p.id}"${p.is_default ? ', default' : ''})`)
    .join(', ')

  const mainTool = defineTool({
    meta: {
      id: 'browser',
      name: 'Browser',
      description: [
        'Control a real browser: navigate pages, interact with UI elements,',
        'take screenshots, extract data.',
        `Available profiles: ${profileListText}.`,
        `Omit profile_id to use the default profile ("${defaultProfile.name}").`,
        '',
        'WORKFLOW:',
        '1. action=open — navigate to a URL.',
        '2. action=snapshot (interactive=true) — read the page as an accessibility tree with refs (@e1, @e2, ...).',
        '3. action=click/type/fill/press — interact using refs from the snapshot.',
        '4. action=screenshot — capture visual state.',
        '',
        'Tab isolation: Studio assigns you your own browser tab automatically; do not use tab_*/close.',
      ].join(' '),
      group: 'browser',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: BrowserToolInputSchema,
    execute: async (args, ctx: ToolContext) => {
      const input = args as BrowserToolInput
      const profile = input.profile_id
        ? activeProfiles.find(p => p.id === input.profile_id)
        : defaultProfile
      if (!profile) {
        throw new Error(
          `Browser profile "${input.profile_id}" not found or not active. ` +
          `Available: ${activeProfiles.map(p => p.id).join(', ')}`,
        )
      }
      const adapter = browserAdapterRegistry.get(profile.adapter_id)
      if (!adapter) {
        throw new Error(`Browser adapter "${profile.adapter_id}" is not registered.`)
      }

      const result = await adapter.execute(input, {
        profileId: profile.id,
        projectId,
        agentId: ctx.runtime.agent.id,
        config: profile.config,
      })
      return { content: result.content }
    },
  })

  const listActionsTool = buildListActionsTool(activeProfiles, defaultProfile)
  const runActionTool = buildRunActionTool(projectId, activeProfiles, defaultProfile)

  return [mainTool, listActionsTool, runActionTool, ...additionalTools]
}

// ─── browser_list_actions ──────────────────────────────────────────────────

const ListActionsInputSchema = z.object({
  profile_id: z.string().optional().describe(
    'Profile to inspect. Omit to use the default profile.',
  ),
})

function buildListActionsTool(
  profiles: BrowserProfile[],
  defaultProfile: BrowserProfile,
): ToolDefinition {
  return defineTool({
    meta: {
      id: 'browser_list_actions',
      name: 'Browser · list custom actions',
      description: [
        'List platform-specific custom actions available for a browser profile.',
        'Different adapters expose different extras (e.g. CamoFox has youtube_transcript,',
        'links, images, downloads, macros). Call this first when you need something',
        'beyond the basic open/snapshot/click/type/screenshot actions.',
        `Available profiles: ${profiles.map(p => `"${p.name}" (${p.id})`).join(', ')}.`,
      ].join(' '),
      group: 'browser',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: ListActionsInputSchema,
    execute: async (args) => {
      const input = args as z.infer<typeof ListActionsInputSchema>
      const profile = input.profile_id
        ? profiles.find(p => p.id === input.profile_id)
        : defaultProfile
      if (!profile) {
        throw new Error(`Browser profile "${input.profile_id}" not found or not active.`)
      }
      const adapter = browserAdapterRegistry.get(profile.adapter_id)
      if (!adapter) throw new Error(`Browser adapter "${profile.adapter_id}" is not registered.`)

      const actions = (adapter.customActions ?? []).map(a => ({
        id: a.id,
        display_name: a.displayName,
        description: a.description,
        input_schema: schemaToJSON(a.inputSchema),
        ...(a.example ? { example: a.example } : {}),
      }))
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              profile_id: profile.id,
              profile_name: profile.name,
              adapter_id: profile.adapter_id,
              actions,
            }, null, 2),
          },
        ],
      }
    },
  })
}

// ─── browser_run_action ────────────────────────────────────────────────────

const RunActionInputSchema = z.object({
  profile_id: z.string().optional().describe('Profile to run the action against. Omit to use the default.'),
  action_id: z.string().describe('Custom action ID, obtained from browser_list_actions.'),
  params: z.record(z.string(), z.unknown()).optional().describe('Params for the action, per its input_schema.'),
})

function buildRunActionTool(
  projectId: string,
  profiles: BrowserProfile[],
  defaultProfile: BrowserProfile,
): ToolDefinition {
  return defineTool({
    meta: {
      id: 'browser_run_action',
      name: 'Browser · run custom action',
      description: [
        'Invoke a platform-specific custom action by id.',
        'Use browser_list_actions first to discover available actions for a profile',
        'and the exact params shape each one expects.',
      ].join(' '),
      group: 'browser',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: RunActionInputSchema,
    execute: async (args, ctx: ToolContext) => {
      const input = args as z.infer<typeof RunActionInputSchema>
      const profile = input.profile_id
        ? profiles.find(p => p.id === input.profile_id)
        : defaultProfile
      if (!profile) throw new Error(`Browser profile "${input.profile_id}" not found or not active.`)

      const adapter = browserAdapterRegistry.get(profile.adapter_id)
      if (!adapter) throw new Error(`Browser adapter "${profile.adapter_id}" is not registered.`)

      const actionDef = adapter.customActions?.find(a => a.id === input.action_id)
      if (!actionDef) {
        const available = (adapter.customActions ?? []).map(a => a.id).join(', ') || '(none)'
        throw new Error(
          `Action "${input.action_id}" not found on adapter "${profile.adapter_id}". Available: ${available}`,
        )
      }
      if (!adapter.runCustomAction) {
        throw new Error(`Adapter "${profile.adapter_id}" declares customActions but does not implement runCustomAction().`)
      }

      // Validate params against the action's inputSchema when provided.
      let validatedParams: unknown = input.params ?? {}
      if (actionDef.inputSchema) {
        const parsed = actionDef.inputSchema.safeParse(validatedParams)
        if (!parsed.success) {
          throw new Error(
            `Invalid params for action "${input.action_id}": ${JSON.stringify(parsed.error)}`,
          )
        }
        validatedParams = parsed.data
      }

      const result = await adapter.runCustomAction(input.action_id, validatedParams, {
        profileId: profile.id,
        projectId,
        agentId: ctx.runtime.agent.id,
        config: profile.config,
      })
      return { content: result.content }
    },
  })
}

// Best-effort conversion of a Zod-like schema into a compact JSON-schema-ish
// object for LLM discovery. We reuse the exact unwrapping that the profile
// routes already do, but that helper lives server-side only; duplicate the
// minimal bits here to avoid pulling routes into the tool path.
function schemaToJSON(schema: unknown): Record<string, unknown> | null {
  if (!schema) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any
  const shape = s?.shape ?? s?._def?.shape?.()
  if (!shape || typeof shape !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(shape as Record<string, unknown>)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = val
    let optional = false
    for (let i = 0; i < 5 && cur; i++) {
      const t = cur?._def?.typeName
      if (t === 'ZodOptional') { optional = true; cur = cur._def.innerType; continue }
      if (t === 'ZodDefault')  { cur = cur._def.innerType; continue }
      if (t === 'ZodNullable') { cur = cur._def.innerType; continue }
      break
    }
    const typeName: string = cur?._def?.typeName ?? 'Unknown'
    out[key] = {
      type: typeName.replace(/^Zod/, '').toLowerCase(),
      optional,
      ...(cur?._def?.description && { description: cur._def.description }),
    }
  }
  return out
}
