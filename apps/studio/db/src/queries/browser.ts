import { eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { projects } from '../schema/index.ts'

export type BrowserMode = 'managed' | 'remote'

export type BrowserProjectConfig = {
  mode?: BrowserMode            // 'managed' (local Playwright) | 'remote' (CDP URL)
  cdp_url?: string              // for mode=remote: e.g. "http://browser:9223"
  headless?: boolean            // default: true (managed only)
  executable_path?: string      // default: auto-detect (managed only)
  control_port?: number         // default: 18791 (managed only)
  timeout_ms?: number           // default: 30000
  no_sandbox?: boolean          // default: false (managed only, for Docker)
  evaluate_enabled?: boolean    // default: true
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
