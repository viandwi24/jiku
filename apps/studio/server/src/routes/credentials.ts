import { Hono } from 'hono'
import {
  getCompanyBySlug,
  getProjectBySlug,
  getAgentBySlug,
  getProjectById,
  getCompanyCredentials,
  getProjectCredentials,
  getAvailableCredentials,
  getCredentialById,
  createCredential,
  updateCredential,
  deleteCredential,
  getAgentCredential,
  assignAgentCredential,
  updateAgentCredential,
  unassignAgentCredential,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { encryptFields } from '../credentials/encryption.ts'
import { getAdaptersByGroup } from '../credentials/adapters.ts'
import { formatCredential, testCredential } from '../credentials/service.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('*', authMiddleware)

// ── Adapter registry ─────────────────────────────────────────────────────────

router.get('/credentials/adapters', (c) => {
  const group_id = c.req.query('group_id') ?? undefined
  const adapters = getAdaptersByGroup(group_id)
  return c.json({ adapters })
})

// ── Company credentials ───────────────────────────────────────────────────────

router.get('/companies/:slug/credentials', async (c) => {
  const slug = c.req.param('slug')
  const company = await getCompanyBySlug(slug)
  if (!company) return c.json({ error: 'Company not found' }, 404)

  const creds = await getCompanyCredentials(company.id)
  return c.json({ credentials: creds.map(formatCredential) })
})

router.post('/companies/:slug/credentials', async (c) => {
  const userId = c.get('user_id')
  const slug = c.req.param('slug')
  const company = await getCompanyBySlug(slug)
  if (!company) return c.json({ error: 'Company not found' }, 404)

  const body = await c.req.json<{
    name: string
    description?: string
    adapter_id: string
    group_id: string
    fields?: Record<string, string>
    metadata?: Record<string, string>
  }>()

  const fields_encrypted = body.fields && Object.keys(body.fields).length > 0
    ? encryptFields(body.fields)
    : null

  const cred = await createCredential({
    name: body.name,
    description: body.description ?? null,
    group_id: body.group_id,
    adapter_id: body.adapter_id,
    scope: 'company',
    scope_id: company.id,
    fields_encrypted,
    metadata: body.metadata ?? {},
    created_by: userId,
  })

  return c.json({ credential: formatCredential(cred) }, 201)
})

// ── Project credentials ───────────────────────────────────────────────────────

router.get('/projects/:slug/credentials', async (c) => {
  const slug = c.req.param('slug')
  // slug is project slug — need company context; look up by project slug globally
  const cred = await _getProjectBySlugParam(slug)
  if (!cred) return c.json({ error: 'Project not found' }, 404)

  const creds = await getProjectCredentials(cred.project.id)
  return c.json({ credentials: creds.map(formatCredential) })
})

router.post('/projects/:slug/credentials', async (c) => {
  const userId = c.get('user_id')
  const slug = c.req.param('slug')
  const cred = await _getProjectBySlugParam(slug)
  if (!cred) return c.json({ error: 'Project not found' }, 404)

  const body = await c.req.json<{
    name: string
    description?: string
    adapter_id: string
    group_id: string
    fields?: Record<string, string>
    metadata?: Record<string, string>
  }>()

  const fields_encrypted = body.fields && Object.keys(body.fields).length > 0
    ? encryptFields(body.fields)
    : null

  const credential = await createCredential({
    name: body.name,
    description: body.description ?? null,
    group_id: body.group_id,
    adapter_id: body.adapter_id,
    scope: 'project',
    scope_id: cred.project.id,
    fields_encrypted,
    metadata: body.metadata ?? {},
    created_by: userId,
  })

  return c.json({ credential: formatCredential(credential) }, 201)
})

// Available credentials for a project (union company + project)
router.get('/projects/:slug/credentials/available', async (c) => {
  const slug = c.req.param('slug')
  const group_id = c.req.query('group_id') ?? undefined
  const result = await _getProjectBySlugParam(slug)
  if (!result) return c.json({ error: 'Project not found' }, 404)

  let creds = await getAvailableCredentials(result.companyId, result.project.id)
  if (group_id) {
    creds = creds.filter(cr => cr.group_id === group_id)
  }

  return c.json({ credentials: creds.map(formatCredential) })
})

// ── Shared credential operations (by ID) ─────────────────────────────────────

router.patch('/credentials/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await getCredentialById(id)
  if (!existing) return c.json({ error: 'Credential not found' }, 404)

  const body = await c.req.json<{
    name?: string
    description?: string
    fields?: Record<string, string>
    metadata?: Record<string, string>
  }>()

  const fields_encrypted = body.fields && Object.keys(body.fields).length > 0
    ? encryptFields(body.fields)
    : undefined

  const cred = await updateCredential(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(fields_encrypted !== undefined ? { fields_encrypted } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
  })

  return c.json({ credential: formatCredential(cred) })
})

router.delete('/credentials/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await getCredentialById(id)
  if (!existing) return c.json({ error: 'Credential not found' }, 404)

  await deleteCredential(id)
  return c.json({ ok: true })
})

router.post('/credentials/:id/test', async (c) => {
  const id = c.req.param('id')
  const cred = await getCredentialById(id)
  if (!cred) return c.json({ error: 'Credential not found' }, 404)

  const result = await testCredential(cred)
  return c.json(result)
})

// ── Agent credential assignment ───────────────────────────────────────────────

router.get('/agents/:slug/credentials', async (c) => {
  const agentId = c.req.param('slug') // may be id or slug; we accept both
  const agentCred = await getAgentCredential(agentId)
  if (!agentCred) return c.json({ agent_credential: null })

  return c.json({
    agent_credential: {
      id: agentCred.id,
      agent_id: agentCred.agent_id,
      credential: formatCredential(agentCred.credential),
      model_id: agentCred.model_id ?? null,
      metadata_override: (agentCred.metadata_override ?? {}) as Record<string, string>,
    },
  })
})

router.post('/agents/:slug/credentials', async (c) => {
  const agentId = c.req.param('slug')
  const body = await c.req.json<{
    credential_id: string
    model_id?: string
    metadata_override?: Record<string, string>
  }>()

  const cred = await getCredentialById(body.credential_id)
  if (!cred) return c.json({ error: 'Credential not found' }, 404)

  // Unassign any existing before assigning new
  await unassignAgentCredential(agentId)

  const ac = await assignAgentCredential({
    agent_id: agentId,
    credential_id: body.credential_id,
    model_id: body.model_id ?? null,
    metadata_override: body.metadata_override ?? {},
  })

  return c.json({ agent_credential: ac }, 201)
})

router.patch('/agents/:slug/credentials', async (c) => {
  const agentId = c.req.param('slug')
  const body = await c.req.json<{
    model_id?: string
    metadata_override?: Record<string, string>
    credential_id?: string
  }>()

  const ac = await updateAgentCredential(agentId, {
    ...(body.model_id !== undefined ? { model_id: body.model_id } : {}),
    ...(body.metadata_override !== undefined ? { metadata_override: body.metadata_override } : {}),
    ...(body.credential_id !== undefined ? { credential_id: body.credential_id } : {}),
  })

  return c.json({ agent_credential: ac })
})

router.delete('/agents/:slug/credentials', async (c) => {
  const agentId = c.req.param('slug')
  await unassignAgentCredential(agentId)
  return c.json({ ok: true })
})

// ── Helper ───────────────────────────────────────────────────────────────────

async function _getProjectBySlugParam(projectId: string): Promise<{ project: { id: string; company_id: string; slug: string; name: string; created_at: Date | null }; companyId: string } | null> {
  // projectId param can be a UUID (for backwards compat) or treated as project id
  const project = await getProjectById(projectId)
  if (!project) return null
  return { project, companyId: project.company_id }
}

export { router as credentialsRouter }
