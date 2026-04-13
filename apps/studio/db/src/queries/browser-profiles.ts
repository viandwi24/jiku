// Plan 20 — CRUD for browser profiles.

import { eq, and, desc } from 'drizzle-orm'
import { db } from '../client.ts'
import { browserProfiles, type BrowserProfile, type NewBrowserProfile } from '../schema/browser-profiles.ts'

export type { BrowserProfile, NewBrowserProfile }

export async function getProjectBrowserProfiles(projectId: string): Promise<BrowserProfile[]> {
  return db
    .select()
    .from(browserProfiles)
    .where(eq(browserProfiles.project_id, projectId))
    .orderBy(desc(browserProfiles.is_default), browserProfiles.created_at)
}

export async function getBrowserProfile(profileId: string): Promise<BrowserProfile | null> {
  const rows = await db.select().from(browserProfiles).where(eq(browserProfiles.id, profileId)).limit(1)
  return rows[0] ?? null
}

export async function getDefaultBrowserProfile(projectId: string): Promise<BrowserProfile | null> {
  const rows = await db
    .select()
    .from(browserProfiles)
    .where(and(eq(browserProfiles.project_id, projectId), eq(browserProfiles.is_default, true)))
    .limit(1)
  return rows[0] ?? null
}

export async function createBrowserProfile(data: NewBrowserProfile): Promise<BrowserProfile> {
  return db.transaction(async (tx) => {
    if (data.is_default) {
      await tx.update(browserProfiles)
        .set({ is_default: false })
        .where(eq(browserProfiles.project_id, data.project_id))
    }
    const [row] = await tx.insert(browserProfiles).values(data).returning()
    if (!row) throw new Error('Failed to create browser profile')
    return row
  })
}

export async function updateBrowserProfile(
  profileId: string,
  patch: Partial<Pick<BrowserProfile, 'name' | 'config' | 'enabled' | 'is_default'>>,
): Promise<BrowserProfile> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(browserProfiles).where(eq(browserProfiles.id, profileId)).limit(1)
    if (!existing) throw new Error(`Browser profile not found: ${profileId}`)
    if (patch.is_default) {
      await tx.update(browserProfiles)
        .set({ is_default: false })
        .where(eq(browserProfiles.project_id, existing.project_id))
    }
    const [row] = await tx.update(browserProfiles)
      .set(patch)
      .where(eq(browserProfiles.id, profileId))
      .returning()
    if (!row) throw new Error('Update returned no row')
    return row
  })
}

export async function deleteBrowserProfile(profileId: string): Promise<void> {
  await db.delete(browserProfiles).where(eq(browserProfiles.id, profileId))
}

export async function setDefaultBrowserProfile(profileId: string, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(browserProfiles)
      .set({ is_default: false })
      .where(eq(browserProfiles.project_id, projectId))
    await tx.update(browserProfiles)
      .set({ is_default: true })
      .where(eq(browserProfiles.id, profileId))
  })
}

/** Used by the browser tab-cleanup worker to iterate every active profile
 *  (across all projects) regardless of which project owns it. */
export async function getAllEnabledBrowserProfiles(): Promise<BrowserProfile[]> {
  return db.select().from(browserProfiles).where(eq(browserProfiles.enabled, true))
}
