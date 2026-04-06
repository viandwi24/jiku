import { Router } from 'express'
import {
  getCompaniesByUserId, createCompany, getCompanyBySlug, updateCompany, deleteCompany,
  seedCompanySystemRoles, addMember, listMembers, removeMember,
  listUserProjectMembershipsInCompany, createProjectMembership, removeProjectMembership,
} from '@jiku-studio/db'
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

router.get('/:cid/members', async (req, res) => {
  const members = await listMembers(req.params['cid'] as string)
  res.json({ members })
})

router.delete('/:cid/members/:uid', async (req, res) => {
  await removeMember(req.params['cid'] as string, req.params['uid'] as string)
  res.json({ ok: true })
})

/** GET /api/companies/:cid/members/:uid/projects — project memberships for a user in this company */
router.get('/:cid/members/:uid/projects', async (req, res) => {
  const { cid, uid } = req.params as { cid: string; uid: string }
  const memberships = await listUserProjectMembershipsInCompany(cid, uid)
  res.json({ memberships })
})

/** POST /api/companies/:cid/members/:uid/projects — grant project access */
router.post('/:cid/members/:uid/projects', async (req, res) => {
  const { uid } = req.params as { cid: string; uid: string }
  const { project_id, role_id } = req.body as { project_id: string; role_id?: string }
  const membership = await createProjectMembership({
    project_id,
    user_id: uid,
    role_id: role_id || null,
    is_superadmin: false,
    agent_restrictions: {},
    tool_restrictions: {},
  })
  res.status(201).json({ membership })
})

/** DELETE /api/companies/:cid/members/:uid/projects/:pid — revoke project access */
router.delete('/:cid/members/:uid/projects/:pid', async (req, res) => {
  const { uid, pid } = req.params as { uid: string; pid: string }
  await removeProjectMembership(pid, uid)
  res.json({ ok: true })
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
