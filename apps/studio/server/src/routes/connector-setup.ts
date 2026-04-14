import { Router } from 'express'
import { getCredentialById, updateCredential } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { audit, auditContext } from '../audit/logger.ts'
import { connectorRegistry } from '../connectors/registry.ts'
import { connectorSetupSessions, SETUP_MAX_RETRIES_PER_STEP } from '../connectors/setup-store.ts'
import { encryptFields, decryptFields } from '../credentials/encryption.ts'
import type { ConnectorSetupSpec, ConnectorSetupStepResult } from '@jiku/types'

/**
 * Plan 24 Phase 1 — Connector interactive setup endpoints.
 *
 * Lifecycle:
 *   POST   /api/projects/:pid/credentials/:credId/setup/start
 *          → returns { setup_session_id, spec } if adapter supports interactive setup.
 *   POST   /api/projects/:pid/credentials/:credId/setup/:sid/step
 *          body: { step_id, input } → returns ConnectorSetupStepResult.
 *          On {complete:true, fields} the route merges fields into the credential,
 *          deletes the session, audits credential.setup_completed.
 *   DELETE /api/projects/:pid/credentials/:credId/setup/:sid
 *          → cancel + cleanup.
 *
 * Adapter resolution: looks up the connector adapter by `credential.adapter_id`.
 * If the adapter doesn't implement `getSetupSpec()` and `runSetupStep()`, returns 400.
 */

const router = Router()
router.use(authMiddleware)

function resolveAdapterForCredential(credential: { adapter_id: string | null }) {
  const adapterId = credential.adapter_id ?? ''
  return connectorRegistry.get(adapterId)
}

router.post(
  '/projects/:pid/credentials/:credId/setup/start',
  requirePermission('credentials:write'),
  async (req, res) => {
    const projectId = req.params['pid']!
    const credentialId = req.params['credId']!

    const cred = await getCredentialById(credentialId)
    if (!cred) { res.status(404).json({ error: 'Credential not found' }); return }
    if (cred.project_id !== projectId && cred.project_id !== null) {
      res.status(403).json({ error: 'Credential does not belong to this project' })
      return
    }

    const adapter = resolveAdapterForCredential(cred)
    if (!adapter) { res.status(404).json({ error: `No adapter registered for "${cred.adapter_id}"` }); return }
    if (typeof adapter.getSetupSpec !== 'function') {
      res.status(400).json({ error: `Adapter "${cred.adapter_id}" does not support interactive setup` })
      return
    }
    const spec: ConnectorSetupSpec | undefined = adapter.getSetupSpec()
    if (!spec || spec.steps.length === 0) {
      res.status(400).json({ error: `Adapter "${cred.adapter_id}" returned an empty setup spec` })
      return
    }

    const session = connectorSetupSessions.create(projectId, credentialId)
    connectorSetupSessions.setStep(session.session_id, spec.steps[0]!.id)

    audit.credentialSetupStarted(
      { ...auditContext(req), project_id: projectId },
      credentialId,
      { adapter_id: cred.adapter_id, session_id: session.session_id, step_count: spec.steps.length },
    )

    res.json({
      setup_session_id: session.session_id,
      spec,
      first_step_id: spec.steps[0]!.id,
      max_retries_per_step: SETUP_MAX_RETRIES_PER_STEP,
    })
  },
)

router.post(
  '/projects/:pid/credentials/:credId/setup/:sid/step',
  requirePermission('credentials:write'),
  async (req, res) => {
    const projectId = req.params['pid']!
    const credentialId = req.params['credId']!
    const sessionId = req.params['sid']!
    const body = req.body as { step_id?: string; input?: Record<string, unknown> }

    if (!body.step_id) { res.status(400).json({ error: 'step_id required' }); return }

    const session = connectorSetupSessions.get(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Setup session not found or expired. Restart the wizard.' })
      return
    }
    if (session.project_id !== projectId || session.credential_id !== credentialId) {
      res.status(403).json({ error: 'Session does not match this credential' })
      return
    }

    const cred = await getCredentialById(credentialId)
    if (!cred) { res.status(404).json({ error: 'Credential not found' }); return }
    const adapter = resolveAdapterForCredential(cred)
    if (!adapter || typeof adapter.runSetupStep !== 'function') {
      res.status(400).json({ error: 'Adapter not setup-capable' })
      return
    }

    // Refresh decrypted credential fields into the session — adapter reads
    // these (e.g. api_id, api_hash, phone_number) instead of importing db.
    session.credential_fields = cred.fields ? decryptFields(cred.fields) : {}

    let result: ConnectorSetupStepResult
    try {
      result = await adapter.runSetupStep(body.step_id, body.input ?? {}, session)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit.credentialSetupFailed(
        { ...auditContext(req), project_id: projectId },
        credentialId,
        { session_id: sessionId, step_id: body.step_id, reason: 'adapter_threw', message },
      )
      res.status(500).json({ ok: false, error: `Adapter threw during step "${body.step_id}": ${message}` })
      return
    }

    // Touch + audit the step regardless of outcome.
    connectorSetupSessions.touch(sessionId)
    audit.credentialSetupStep(
      { ...auditContext(req), project_id: projectId },
      credentialId,
      { session_id: sessionId, step_id: body.step_id, ok: result.ok },
    )

    if (result.ok && 'complete' in result && result.complete) {
      // Persist the returned fields into the credential. Merge into existing
      // fields so partial setup writes (session_string + user_id + ...) coexist
      // with whatever the user already configured manually.
      const existing = cred.fields ? decryptFields(cred.fields) : {}
      const merged: Record<string, string> = { ...existing }
      for (const [k, v] of Object.entries(result.fields)) {
        merged[k] = v === null || v === undefined ? '' : String(v)
      }
      await updateCredential(credentialId, { fields: encryptFields(merged) })
      connectorSetupSessions.delete(sessionId)
      audit.credentialSetupCompleted(
        { ...auditContext(req), project_id: projectId },
        credentialId,
        { session_id: sessionId, step_id: body.step_id, persisted_field_count: Object.keys(result.fields).length },
      )
      res.json(result)
      return
    }

    if (result.ok) {
      // Advance to next step.
      if (result.next_step) connectorSetupSessions.setStep(sessionId, result.next_step)
      res.json(result)
      return
    }

    // Failure path. Bump retry counter; abort if cap exceeded.
    const retry = connectorSetupSessions.bumpRetry(sessionId)
    if (retry.capped) {
      connectorSetupSessions.delete(sessionId)
      audit.credentialSetupFailed(
        { ...auditContext(req), project_id: projectId },
        credentialId,
        { session_id: sessionId, step_id: body.step_id, reason: 'retry_cap_exceeded', retry_count: retry.count, message: result.error },
      )
      res.status(400).json({ ...result, aborted: true, reason: 'retry_cap_exceeded' })
      return
    }
    if (result.retry_step) connectorSetupSessions.setStep(sessionId, result.retry_step)
    res.json({ ...result, retry_count: retry.count, max_retries: SETUP_MAX_RETRIES_PER_STEP })
  },
)

router.delete(
  '/projects/:pid/credentials/:credId/setup/:sid',
  requirePermission('credentials:write'),
  async (req, res) => {
    const projectId = req.params['pid']!
    const credentialId = req.params['credId']!
    const sessionId = req.params['sid']!
    const session = connectorSetupSessions.get(sessionId)
    if (session && session.project_id === projectId && session.credential_id === credentialId) {
      connectorSetupSessions.delete(sessionId)
      audit.credentialSetupCancelled(
        { ...auditContext(req), project_id: projectId },
        credentialId,
        { session_id: sessionId, current_step_id: session.current_step_id },
      )
    }
    res.json({ ok: true })
  },
)

export { router as connectorSetupRouter }
