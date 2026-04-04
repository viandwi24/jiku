import { Hono } from 'hono'
import { getCompaniesByUserId, createCompany, getCompanyBySlug, getCompanyById, updateCompany, deleteCompany, seedCompanySystemRoles, addMember } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { uniqueSlug } from '../utils/slug.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('*', authMiddleware)

router.get('/', async (c) => {
  const userId = c.get('user_id')
  const companies = await getCompaniesByUserId(userId)
  return c.json({ companies })
})

router.post('/', async (c) => {
  const userId = c.get('user_id')
  const body = await c.req.json<{ name: string; slug?: string }>()

  const slug = await uniqueSlug(
    body.slug ?? body.name,
    async (s) => !!(await getCompanyBySlug(s)),
  )

  const company = await createCompany({ name: body.name, slug, owner_id: userId })

  const systemRoles = await seedCompanySystemRoles(company.id)
  const ownerRole = systemRoles.find(r => r.name === 'Owner')!

  await addMember(company.id, userId, ownerRole.id)

  return c.json({ company }, 201)
})

router.patch('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const company = await getCompanyBySlug(slug)
  if (!company) return c.json({ error: 'Company not found' }, 404)

  const body = await c.req.json<{ name?: string; slug?: string }>()

  // Ensure new slug is unique (if changing)
  let newSlug = body.slug
  if (newSlug && newSlug !== company.slug) {
    const existing = await getCompanyBySlug(newSlug)
    if (existing) return c.json({ error: 'Slug already taken' }, 409)
  }

  const updated = await updateCompany(company.id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(newSlug !== undefined ? { slug: newSlug } : {}),
  })

  return c.json({ company: updated })
})

router.delete('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const company = await getCompanyBySlug(slug)
  if (!company) return c.json({ error: 'Company not found' }, 404)

  await deleteCompany(company.id)
  return c.json({ ok: true })
})

export { router as companiesRouter }
