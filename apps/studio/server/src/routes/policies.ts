import { Router } from 'express'
import { getPolicies, getPolicyById, createPolicy, updatePolicy, deletePolicy, getPolicyRules, createPolicyRule, deletePolicyRule, getAgentPolicies, attachPolicy, detachPolicy, getUserPoliciesForAgent, getAgentUserPolicy, upsertAgentUserPolicy, getMember } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'

const router = Router()
router.use(authMiddleware)

router.get('/companies/:cid/policies', async (req, res) => {
  const list = await getPolicies(req.params['cid']!)
  res.json({ policies: list })
})

router.post('/companies/:cid/policies', async (req, res) => {
  const { name, description, is_template } = req.body as { name: string; description?: string; is_template?: boolean }
  const policy = await createPolicy({ company_id: req.params['cid']!, name, description, is_template })
  res.status(201).json({ policy })
})

router.get('/policies/:pid', async (req, res) => {
  const policy = await getPolicyById(req.params['pid']!)
  if (!policy) { res.status(404).json({ error: 'Policy not found' }); return }
  res.json({ policy })
})

router.patch('/policies/:pid', async (req, res) => {
  const policy = await updatePolicy(req.params['pid']!, req.body)
  res.json({ policy })
})

router.delete('/policies/:pid', async (req, res) => {
  await deletePolicy(req.params['pid']!)
  res.json({ ok: true })
})

router.get('/policies/:pid/rules', async (req, res) => {
  const rules = await getPolicyRules(req.params['pid']!)
  res.json({ rules })
})

router.post('/policies/:pid/rules', async (req, res) => {
  const rule = await createPolicyRule({ policy_id: req.params['pid']!, ...req.body })
  res.status(201).json({ rule })
})

router.delete('/policies/:pid/rules/:rid', async (req, res) => {
  await deletePolicyRule(req.params['rid']!)
  res.json({ ok: true })
})

router.get('/agents/:aid/policies', async (req, res) => {
  const list = await getAgentPolicies(req.params['aid']!)
  res.json({ policies: list })
})

router.post('/agents/:aid/policies', async (req, res) => {
  const { policy_id, project_id, priority } = req.body as { policy_id: string; project_id: string; priority?: number }
  await attachPolicy(req.params['aid']!, policy_id, priority)
  await runtimeManager.syncRules(project_id)
  res.status(201).json({ ok: true })
})

router.delete('/agents/:aid/policies/:pid', async (req, res) => {
  const projectId = req.query['project_id'] as string | undefined
  await detachPolicy(req.params['aid']!, req.params['pid']!)
  if (projectId) await runtimeManager.syncRules(projectId)
  res.json({ ok: true })
})

router.get('/agents/:aid/policies/users', async (req, res) => {
  const list = await getUserPoliciesForAgent(req.params['aid']!)
  res.json({ policies: list })
})

router.get('/agents/:aid/policies/users/me', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const policy = await getAgentUserPolicy(req.params['aid']!, userId)
  res.json({ policy })
})

router.patch('/agents/:aid/policies/users/:uid', async (req, res) => {
  const { allowed_permissions, company_id } = req.body as { allowed_permissions: string[]; company_id: string }
  const member = await getMember(company_id, req.params['uid']!)
  if (!member) { res.status(400).json({ error: 'User is not a member of this company' }); return }

  const actualPermissions = member.role.role_permissions.map(rp => rp.permission.key)
  const invalidPerms = allowed_permissions.filter(p => !actualPermissions.includes(p))
  if (invalidPerms.length > 0) {
    res.status(400).json({ error: `Cannot grant permissions not held by user: ${invalidPerms.join(', ')}` })
    return
  }

  const policy = await upsertAgentUserPolicy(req.params['aid']!, req.params['uid']!, allowed_permissions)
  res.json({ policy })
})

export { router as policiesRouter }
