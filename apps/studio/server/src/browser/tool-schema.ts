import { z } from 'zod'

/**
 * Input schema for the `browser` tool.
 *
 * IMPORTANT: This must be a flat `z.object` so it serializes to a JSON Schema
 * with `type: "object"` at the root. OpenAI's function calling API rejects
 * `oneOf` / `anyOf` at the root level — that's why this schema cannot be a
 * `z.discriminatedUnion`. Per-action field requirements are enforced by the
 * mapper in `execute.ts` instead.
 *
 * Every action listed in `action` here must have a matching `case` in
 * `mapToBrowserCommand()`. The `never` exhaustiveness check there ensures
 * compile-time coverage.
 */
export const BROWSER_ACTIONS = [
  // Navigation
  'open', 'back', 'forward', 'reload', 'close',
  // Observation
  'snapshot', 'screenshot', 'pdf', 'get',
  // Interaction
  'click', 'dblclick', 'fill', 'type', 'press', 'hover', 'focus',
  'check', 'uncheck', 'select', 'drag', 'upload', 'scroll', 'scrollintoview',
  // Wait
  'wait',
  // Tabs
  'tab_list', 'tab_new', 'tab_close', 'tab_switch',
  // JavaScript
  'eval',
  // Cookies & storage
  'cookies_get', 'cookies_set', 'cookies_clear', 'storage',
  // Batch
  'batch',
] as const

export const BrowserToolInputSchema = z.object({
  action: z.enum(BROWSER_ACTIONS).describe(
    'The browser action to perform. See the tool description for the list and required fields per action.',
  ),

  // ─── Navigation / URLs ──────────────────────────────────────────────────
  url: z.string().optional().describe(
    'URL string. REQUIRED for: open. Optional for: tab_new, wait (wait until URL pattern matches).',
  ),

  // ─── Element reference (from a snapshot) ────────────────────────────────
  ref: z.string().optional().describe(
    'Element ref from a snapshot (e.g. "@e3"). REQUIRED for: click, dblclick, fill, type, hover, focus, check, uncheck, select, upload, scrollintoview. Optional for: wait, get.',
  ),

  // ─── Text inputs ────────────────────────────────────────────────────────
  text: z.string().optional().describe(
    'Text payload. REQUIRED for: fill (replaces field), type (appends to field). Optional for: wait (wait until this text appears on the page).',
  ),
  key: z.string().optional().describe(
    'Keyboard key (e.g. "Enter", "Tab", "Control+a"). REQUIRED for: press.',
  ),
  values: z.array(z.string()).optional().describe(
    'Values to select. REQUIRED for: select.',
  ),

  // ─── Drag ───────────────────────────────────────────────────────────────
  src: z.string().optional().describe('Drag source ref. REQUIRED for: drag.'),
  dst: z.string().optional().describe('Drag destination ref. REQUIRED for: drag.'),

  // ─── Upload ─────────────────────────────────────────────────────────────
  files: z.array(z.string()).optional().describe(
    'Absolute paths of files to upload. REQUIRED for: upload.',
  ),

  // ─── Scroll ─────────────────────────────────────────────────────────────
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe(
    'Scroll direction. REQUIRED for: scroll.',
  ),
  pixels: z.number().int().positive().optional().describe(
    'Number of pixels to scroll. Optional for: scroll.',
  ),
  newTab: z.boolean().optional().describe(
    'Open click target in a new tab. Optional for: click.',
  ),

  // ─── Snapshot ───────────────────────────────────────────────────────────
  interactive: z.boolean().optional().describe(
    'Snapshot only interactive elements (recommended). Optional for: snapshot.',
  ),
  compact: z.boolean().optional().describe(
    'Remove empty structural elements from the snapshot. Optional for: snapshot.',
  ),
  depth: z.number().int().positive().optional().describe(
    'Maximum tree depth for the snapshot. Optional for: snapshot.',
  ),
  selector: z.string().optional().describe(
    'CSS selector to scope the snapshot. Optional for: snapshot.',
  ),

  // ─── Screenshot ─────────────────────────────────────────────────────────
  full: z.boolean().optional().describe(
    'Capture the full scrollable page instead of the viewport. Optional for: screenshot.',
  ),
  annotate: z.boolean().optional().describe(
    'Add numbered labels to interactive elements in the screenshot. Optional for: screenshot.',
  ),

  // ─── Get / PDF ──────────────────────────────────────────────────────────
  subcommand: z.enum([
    'text', 'html', 'value', 'attr', 'title', 'url',
    'count', 'box', 'styles', 'cdp-url',
  ]).optional().describe(
    'What to query. REQUIRED for: get.',
  ),
  attr: z.string().optional().describe(
    'Attribute name. REQUIRED for: get with subcommand="attr".',
  ),
  path: z.string().optional().describe(
    'Output file path. REQUIRED for: pdf.',
  ),

  // ─── Wait ───────────────────────────────────────────────────────────────
  ms: z.number().int().nonnegative().optional().describe(
    'Fixed delay in milliseconds. Optional for: wait.',
  ),

  // ─── Tabs ───────────────────────────────────────────────────────────────
  index: z.number().int().nonnegative().optional().describe(
    'Tab index. REQUIRED for: tab_switch. Optional for: tab_close.',
  ),

  // ─── JavaScript ─────────────────────────────────────────────────────────
  js: z.string().optional().describe(
    'JavaScript source to evaluate in the page context. REQUIRED for: eval.',
  ),

  // ─── Cookies & storage ──────────────────────────────────────────────────
  cookie: z.record(z.string(), z.unknown()).optional().describe(
    'Cookie object (name/value/domain/...). REQUIRED for: cookies_set.',
  ),
  storageType: z.enum(['local', 'session']).optional().describe(
    'Web storage area to read. REQUIRED for: storage.',
  ),

  // ─── Batch ──────────────────────────────────────────────────────────────
  commands: z.array(z.string()).optional().describe(
    'List of agent-browser CLI command strings to execute sequentially. REQUIRED for: batch.',
  ),
})

export type BrowserToolInput = z.infer<typeof BrowserToolInputSchema>
export type BrowserAction = (typeof BROWSER_ACTIONS)[number]
