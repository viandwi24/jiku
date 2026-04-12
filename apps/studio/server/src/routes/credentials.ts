import { Router } from 'express'
import { getCompanyBySlug, getProjectById, getCompanyCredentials, getProjectCredentials, getAvailableCredentials, getCredentialById, createCredential, updateCredential, deleteCredential, getAgentCredential, assignAgentCredential, updateAgentCredential, unassignAgentCredential } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, loadPerms } from '../middleware/permission.ts'
import { encryptFields } from '../credentials/encryption.ts'
import { getAllAdapters } from '../credentials/adapters.ts'
import { formatCredential, testCredential } from '../credentials/service.ts'
import { credentialRateLimit } from '../middleware/rate-limit.ts'
import { audit, auditContext } from '../audit/logger.ts'

const router = Router()
router.use(authMiddleware)
router.use(credentialRateLimit)

router.get('/credentials/adapters', (req, res) => {
  const group_id = req.query['group_id'] as string | undefined
  res.json({ adapters: getAllAdapters(group_id) })
})

router.get('/companies/:slug/credentials', async (req, res) => {
  const company = await getCompanyBySlug(req.params['slug']!)
  if (!company) { res.status(404).json({ error: 'Company not found' }); return }
  const creds = await getCompanyCredentials(company.id)
  res.json({ credentials: creds.map(formatCredential) })
})

router.post('/companies/:slug/credentials', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const company = await getCompanyBySlug(req.params['slug']!)
  if (!company) { res.status(404).json({ error: 'Company not found' }); return }

  const { name, description, adapter_id, group_id, fields, metadata } = req.body as { name: string; description?: string; adapter_id: string; group_id: string; fields?: Record<string, string>; metadata?: Record<string, string> }
  const fields_encrypted = fields && Object.keys(fields).length > 0 ? encryptFields(fields) : null
  const cred = await createCredential({ name, description: description ?? null, group_id, adapter_id, scope: 'company', scope_id: company.id, fields_encrypted, metadata: metadata ?? {}, created_by: userId })
  audit.secretCreate({ ...auditContext(req), company_id: company.id }, cred.id, cred.name)
  res.status(201).json({ credential: formatCredential(cred) })
})

router.get('/projects/:pid/credentials', requirePermission('settings:read'), async (req, res) => {
  const project = await getProjectById(req.params['pid']!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const creds = await getProjectCredentials(project.id)
  res.json({ credentials: creds.map(formatCredential) })
})

router.post('/projects/:pid/credentials', requirePermission('settings:write'), async (req, res) => {
  const userId = res.locals['user_id'] as string
  const project = await getProjectById(req.params['pid']!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { name, description, adapter_id, group_id, fields, metadata } = req.body as { name: string; description?: string; adapter_id: string; group_id: string; fields?: Record<string, string>; metadata?: Record<string, string> }
  const fields_encrypted = fields && Object.keys(fields).length > 0 ? encryptFields(fields) : null
  const cred = await createCredential({ name, description: description ?? null, group_id, adapter_id, scope: 'project', scope_id: project.id, fields_encrypted, metadata: metadata ?? {}, created_by: userId })
  audit.secretCreate({ ...auditContext(req), project_id: project.id }, cred.id, cred.name)
  res.status(201).json({ credential: formatCredential(cred) })
})

router.get('/projects/:pid/credentials/available', requirePermission('settings:read'), async (req, res) => {
  const project = await getProjectById(req.params['pid']!)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const group_id = req.query['group_id'] as string | undefined
  let creds = await getAvailableCredentials(project.company_id, project.id)
  if (group_id) creds = creds.filter(c => c.group_id === group_id)
  res.json({ credentials: creds.map(formatCredential) })
})

/** Resolve project_id from a credential's scope, then check permission */
async function checkCredentialPermission(
  req: import('express').Request,
  res: import('express').Response,
  permission: 'settings:read' | 'settings:write',
  credId: string,
): Promise<boolean> {
  const cred = await getCredentialById(credId)
  if (!cred) { res.status(404).json({ error: 'Credential not found' }); return false }
  // Only enforce project-scoped credential ACL; company-scoped creds are accessible to any authenticated user
  if (cred.scope === 'project') {
    res.locals['project_id'] = cred.scope_id
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return false }
    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member' }); return false }
    if (!resolved.isSuperadmin && !resolved.permissions.includes(permission)) {
      res.status(403).json({ error: `Missing permission: ${permission}` }); return false
    }
  }
  return true
}

router.patch('/credentials/:id', async (req, res) => {
  if (!await checkCredentialPermission(req, res, 'settings:write', req.params['id']!)) return

  const existing = await getCredentialById(req.params['id']!)
  if (!existing) { res.status(404).json({ error: 'Credential not found' }); return }

  const { name, description, fields, metadata } = req.body as { name?: string; description?: string; fields?: Record<string, string>; metadata?: Record<string, string> }
  const fields_encrypted = fields && Object.keys(fields).length > 0 ? encryptFields(fields) : undefined
  const cred = await updateCredential(req.params['id']!, {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(fields_encrypted !== undefined ? { fields_encrypted } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  })
  res.json({ credential: formatCredential(cred) })
})

router.delete('/credentials/:id', async (req, res) => {
  if (!await checkCredentialPermission(req, res, 'settings:write', req.params['id']!)) return

  const existing = await getCredentialById(req.params['id']!)
  if (!existing) { res.status(404).json({ error: 'Credential not found' }); return }
  await deleteCredential(req.params['id']!)
  const ctx = auditContext(req)
  if (existing.scope === 'project') ctx.project_id = existing.scope_id
  else ctx.company_id = existing.scope_id
  audit.secretDelete(ctx, existing.id, existing.name)
  res.json({ ok: true })
})

router.post('/credentials/:id/test', async (req, res) => {
  if (!await checkCredentialPermission(req, res, 'settings:read', req.params['id']!)) return

  const cred = await getCredentialById(req.params['id']!)
  if (!cred) { res.status(404).json({ error: 'Credential not found' }); return }
  const result = await testCredential(cred)
  res.json(result)
})

router.get('/agents/:aid/credentials', requirePermission('agents:read'), async (req, res) => {
  const agentCred = await getAgentCredential(req.params['aid']!)
  if (!agentCred) { res.json({ agent_credential: null }); return }
  res.json({
    agent_credential: {
      id: agentCred.id,
      agent_id: agentCred.agent_id,
      credential: formatCredential(agentCred.credential),
      model_id: agentCred.model_id ?? null,
      metadata_override: (agentCred.metadata_override ?? {}) as Record<string, string>,
    },
  })
})

router.post('/agents/:aid/credentials', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const { credential_id, model_id, metadata_override } = req.body as { credential_id: string; model_id?: string; metadata_override?: Record<string, string> }
  const cred = await getCredentialById(credential_id)
  if (!cred) { res.status(404).json({ error: 'Credential not found' }); return }

  await unassignAgentCredential(agentId)
  const ac = await assignAgentCredential({ agent_id: agentId, credential_id, model_id: model_id ?? null, metadata_override: metadata_override ?? {} })
  res.status(201).json({ agent_credential: ac })
})

router.patch('/agents/:aid/credentials', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const { model_id, metadata_override, credential_id } = req.body as { model_id?: string; metadata_override?: Record<string, string>; credential_id?: string }
  const ac = await updateAgentCredential(agentId, {
    ...(model_id !== undefined ? { model_id } : {}),
    ...(metadata_override !== undefined ? { metadata_override } : {}),
    ...(credential_id !== undefined ? { credential_id } : {}),
  })
  res.json({ agent_credential: ac })
})

router.delete('/agents/:aid/credentials', requirePermission('agents:write'), async (req, res) => {
  await unassignAgentCredential(req.params['aid']!)
  res.json({ ok: true })
})

export { router as credentialsRouter }
