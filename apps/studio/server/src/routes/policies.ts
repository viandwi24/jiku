import { Hono } from 'hono'
import {
  getPolicies,
  getPolicyById,
  createPolicy,
  updatePolicy,
  deletePolicy,
  getPolicyRules,
  createPolicyRule,
  deletePolicyRule,
  getAgentPolicies,
  attachPolicy,
  detachPolicy,
  getUserPoliciesForAgent,
  getAgentUserPolicy,
  upsertAgentUserPolicy,
  getMember,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('*', authMiddleware)

// ── Company-level policy CRUD ─────────────────────────────────────────────────

router.get('/companies/:cid/policies', async (c) => {
  const companyId = c.req.param('cid')
  const list = await getPolicies(companyId)
  return c.json({ policies: list })
})

router.post('/companies/:cid/policies', async (c) => {
  const companyId = c.req.param('cid')
  const body = await c.req.json<{
    name: string
    description?: string
    is_template?: boolean
  }>()
  const policy = await createPolicy({ company_id: companyId, ...body })
  return c.json({ policy }, 201)
})

router.get('/policies/:pid', async (c) => {
  const policy = await getPolicyById(c.req.param('pid'))
  if (!policy) return c.json({ error: 'Policy not found' }, 404)
  return c.json({ policy })
})

router.patch('/policies/:pid', async (c) => {
  const body = await c.req.json<{ name?: string; description?: string; is_template?: boolean }>()
  const policy = await updatePolicy(c.req.param('pid'), body)
  return c.json({ policy })
})

router.delete('/policies/:pid', async (c) => {
  await deletePolicy(c.req.param('pid'))
  return c.json({ ok: true })
})

// ── Policy rules (by policy, not agent) ──────────────────────────────────────

router.get('/policies/:pid/rules', async (c) => {
  const rules = await getPolicyRules(c.req.param('pid'))
  return c.json({ rules })
})

router.post('/policies/:pid/rules', async (c) => {
  const policyId = c.req.param('pid')
  const body = await c.req.json<{
    resource_type: string
    resource_id: string
    subject_type: string
    subject: string
    effect: string
    priority?: number
    conditions?: unknown[]
  }>()
  const rule = await createPolicyRule({ policy_id: policyId, ...body })
  return c.json({ rule }, 201)
})

router.delete('/policies/:pid/rules/:rid', async (c) => {
  await deletePolicyRule(c.req.param('rid'))
  return c.json({ ok: true })
})

// ── Agent ↔ Policy attachment ─────────────────────────────────────────────────

router.get('/agents/:aid/policies', async (c) => {
  const agentId = c.req.param('aid')
  const list = await getAgentPolicies(agentId)
  return c.json({ policies: list })
})

router.post('/agents/:aid/policies', async (c) => {
  const agentId = c.req.param('aid')
  const body = await c.req.json<{ policy_id: string; project_id: string; priority?: number }>()
  await attachPolicy(agentId, body.policy_id, body.priority)
  await runtimeManager.syncRules(body.project_id)
  return c.json({ ok: true }, 201)
})

router.delete('/agents/:aid/policies/:pid', async (c) => {
  const agentId = c.req.param('aid')
  const policyId = c.req.param('pid')
  const projectId = c.req.query('project_id') ?? ''
  await detachPolicy(agentId, policyId)
  if (projectId) await runtimeManager.syncRules(projectId)
  return c.json({ ok: true })
})

// ── Agent user policies (self-restriction) ────────────────────────────────────

router.get('/agents/:aid/policies/users', async (c) => {
  const agentId = c.req.param('aid')
  const list = await getUserPoliciesForAgent(agentId)
  return c.json({ policies: list })
})

router.get('/agents/:aid/policies/users/me', async (c) => {
  const agentId = c.req.param('aid')
  const userId = c.get('user_id')
  const policy = await getAgentUserPolicy(agentId, userId)
  return c.json({ policy })
})

router.patch('/agents/:aid/policies/users/:uid', async (c) => {
  const agentId = c.req.param('aid')
  const targetUserId = c.req.param('uid')
  const body = await c.req.json<{ allowed_permissions: string[]; company_id: string }>()

  const member = await getMember(body.company_id, targetUserId)
  if (!member) return c.json({ error: 'User is not a member of this company' }, 400)

  const actualPermissions = member.role.role_permissions.map(rp => rp.permission.key)
  const invalidPerms = body.allowed_permissions.filter(p => !actualPermissions.includes(p))
  if (invalidPerms.length > 0) {
    return c.json({ error: `Cannot grant permissions not held by user: ${invalidPerms.join(', ')}` }, 400)
  }

  const policy = await upsertAgentUserPolicy(agentId, targetUserId, body.allowed_permissions)
  return c.json({ policy })
})

export { router as policiesRouter }
