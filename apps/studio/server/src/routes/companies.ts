import { Router } from 'express'
import { getCompaniesByUserId, createCompany, getCompanyBySlug, updateCompany, deleteCompany, seedCompanySystemRoles, addMember } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { uniqueSlug } from '../utils/slug.ts'

const router = Router()
router.use(authMiddleware)

router.get('/', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const companies = await getCompaniesByUserId(userId)
  res.json({ companies })
})

router.post('/', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const { name, slug: rawSlug } = req.body as { name: string; slug?: string }

  const slug = await uniqueSlug(rawSlug ?? name, async (s) => !!(await getCompanyBySlug(s)))
  const company = await createCompany({ name, slug, owner_id: userId })

  const systemRoles = await seedCompanySystemRoles(company.id)
  const ownerRole = systemRoles.find(r => r.name === 'Owner')!
  await addMember(company.id, userId, ownerRole.id)

  res.status(201).json({ company })
})

router.patch('/:slug', async (req, res) => {
  const company = await getCompanyBySlug(req.params['slug']!)
  if (!company) { res.status(404).json({ error: 'Company not found' }); return }

  const { name, slug: newSlug } = req.body as { name?: string; slug?: string }
  if (newSlug && newSlug !== company.slug) {
    const existing = await getCompanyBySlug(newSlug)
    if (existing) { res.status(409).json({ error: 'Slug already taken' }); return }
  }

  const updated = await updateCompany(company.id, {
    ...(name !== undefined ? { name } : {}),
    ...(newSlug !== undefined ? { slug: newSlug } : {}),
  })
  res.json({ company: updated })
})

router.delete('/:slug', async (req, res) => {
  const company = await getCompanyBySlug(req.params['slug']!)
  if (!company) { res.status(404).json({ error: 'Company not found' }); return }

  await deleteCompany(company.id)
  res.json({ ok: true })
})

export { router as companiesRouter }
