import { and, eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { companies, company_members, roles } from '../schema/index.ts'
import type { NewCompany } from '../schema/index.ts'

export async function getCompaniesByUserId(userId: string) {
  const memberships = await db.query.company_members.findMany({
    where: eq(company_members.user_id, userId),
    with: { company: true },
  })
  return memberships.map(m => m.company)
}

export async function getCompanyBySlug(slug: string) {
  return db.query.companies.findFirst({
    where: eq(companies.slug, slug),
  })
}

export async function getCompanyById(id: string) {
  return db.query.companies.findFirst({
    where: eq(companies.id, id),
  })
}

export async function createCompany(data: Omit<NewCompany, 'id' | 'created_at'>) {
  const [company] = await db.insert(companies).values(data).returning()
  return company!
}

export async function getMember(companyId: string, userId: string) {
  return db.query.company_members.findFirst({
    where: and(
      eq(company_members.company_id, companyId),
      eq(company_members.user_id, userId),
    ),
    with: {
      role: {
        with: {
          role_permissions: {
            with: { permission: true },
          },
        },
      },
    },
  })
}

export async function updateCompany(id: string, data: Partial<Omit<NewCompany, 'id' | 'created_at'>>) {
  const [company] = await db.update(companies).set(data).where(eq(companies.id, id)).returning()
  return company!
}

export async function deleteCompany(id: string) {
  await db.delete(companies).where(eq(companies.id, id))
}

export async function addMember(companyId: string, userId: string, roleId: string) {
  const [member] = await db
    .insert(company_members)
    .values({ company_id: companyId, user_id: userId, role_id: roleId })
    .returning()
  return member!
}

export async function getSystemRoleByName(companyId: string, name: string) {
  return db.query.roles.findFirst({
    where: and(
      eq(roles.company_id, companyId),
      eq(roles.name, name),
    ),
  })
}
