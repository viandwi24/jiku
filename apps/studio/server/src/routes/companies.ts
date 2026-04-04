import { Hono } from 'hono'
import { getCompaniesByUserId, createCompany, seedCompanySystemRoles, addMember } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
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
  const body = await c.req.json<{ name: string; slug: string }>()

  const company = await createCompany({ name: body.name, slug: body.slug, owner_id: userId })

  const systemRoles = await seedCompanySystemRoles(company.id)
  const ownerRole = systemRoles.find(r => r.name === 'Owner')!

  await addMember(company.id, userId, ownerRole.id)

  return c.json({ company }, 201)
})

export { router as companiesRouter }
