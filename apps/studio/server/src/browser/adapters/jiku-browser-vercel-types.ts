// Shared config type for the built-in Jiku Browser (Vercel agent-browser)
// adapter. Kept in its own file so the tab-manager can reference the shape
// without importing the adapter class (which would create a cycle through
// execute.ts).

export interface JikuBrowserVercelConfig {
  /** CDP endpoint, e.g. "ws://localhost:9222". */
  cdp_url?: string
  /** Per-command timeout in milliseconds (default: 30000). */
  timeout_ms?: number
  /** Allow agents to call `eval` (run arbitrary JS in the page). */
  evaluate_enabled?: boolean
  /** Persist screenshots to S3 (true, default) or inline base64 (false). */
  screenshot_as_attachment?: boolean
  /** Max chromium tabs for this profile. Bounds: 2..50. Default: 10. */
  max_tabs?: number
}
