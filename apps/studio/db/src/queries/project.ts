import { and, eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { projects } from '../schema/index.ts'
import type { NewProject } from '../schema/index.ts'

export async function getAllProjects() {
  return db.query.projects.findMany()
}

export async function getProjectsByCompanyId(companyId: string) {
  return db.query.projects.findMany({
    where: eq(projects.company_id, companyId),
  })
}

export async function getProjectById(id: string) {
  return db.query.projects.findFirst({
    where: eq(projects.id, id),
  })
}

export async function getProjectBySlug(companyId: string, slug: string) {
  return db.query.projects.findFirst({
    where: and(
      eq(projects.company_id, companyId),
      eq(projects.slug, slug),
    ),
  })
}

export async function createProject(data: Omit<NewProject, 'id' | 'created_at'>) {
  const [project] = await db.insert(projects).values(data).returning()
  return project!
}

export async function updateProject(id: string, data: Partial<Omit<NewProject, 'id' | 'created_at'>>) {
  const [project] = await db.update(projects).set(data).where(eq(projects.id, id)).returning()
  return project!
}

export async function deleteProject(id: string) {
  await db.delete(projects).where(eq(projects.id, id))
}
