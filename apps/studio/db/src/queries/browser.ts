import { eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { projects } from '../schema/index.ts'

/**
 * Browser config — CDP-only since Plan 33 (`@jiku/browser` migration).
 *
 * Legacy fields (`mode`, `headless`, `executable_path`, `control_port`,
 * `no_sandbox`) were removed when the OpenClaw port was deleted. Stored
 * configs that still contain them will simply ignore those keys.
 */
export type BrowserProjectConfig = {
  /** CDP endpoint, e.g. "ws://localhost:9222" or "http://localhost:9222". */
  cdp_url?: string
  /** Default per-command timeout in milliseconds (default: 30_000). */
  timeout_ms?: number
  /** Allow agents to call `eval` (run arbitrary JS in the page). */
  evaluate_enabled?: boolean
  /**
   * If true (default), screenshots are persisted to S3 and returned as
   * attachment references. If false, they are returned inline as base64.
   */
  screenshot_as_attachment?: boolean
  /**
   * Maximum number of chromium tabs this project may hold open at once,
   * including the system tab at index 0. When the cap is hit, the
   * least-recently-used agent tab is evicted before creating a new one.
   * Default: 10. Bounds: 2..50 (enforced by the route Zod schema).
   */
  max_tabs?: number
}

export async function getProjectBrowserConfig(projectId: string): Promise<{
  enabled: boolean
  config: BrowserProjectConfig
}> {
  const row = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { browser_enabled: true, browser_config: true },
  })
  return {
    enabled: row?.browser_enabled ?? false,
    config: (row?.browser_config as BrowserProjectConfig | null) ?? {},
  }
}

export async function setProjectBrowserEnabled(projectId: string, enabled: boolean) {
  return db.update(projects)
    .set({ browser_enabled: enabled })
    .where(eq(projects.id, projectId))
}

export async function setProjectBrowserConfig(projectId: string, config: BrowserProjectConfig) {
  return db.update(projects)
    .set({ browser_config: config })
    .where(eq(projects.id, projectId))
}
