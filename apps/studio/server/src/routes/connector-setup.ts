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

/**
 * Resolve the connector adapter that owns a given credential. Looks up by the
 * adapter's `credentialAdapterId` (NOT its `id`) — credentials store the
 * `adapter_id` of the credential row, which corresponds to the adapter's
 * declared `credentialAdapterId` (e.g. 'telegram', 'telegram-user'), while
 * the registry keys adapters by the connector_id (e.g. 'jiku.telegram.bot',
 * 'jiku.telegram.user'). Walk the registry to find the matching one.
 */
function resolveAdapterForCredential(credential: { adapter_id: string | null }) {
  const credAdapterId = credential.adapter_id ?? ''
  if (!credAdapterId) return undefined
  // First try direct id match (legacy adapters where id === credentialAdapterId).
  const direct = connectorRegistry.get(credAdapterId)
  if (direct) return direct
  // Then walk by credentialAdapterId.
  for (const adapter of connectorRegistry.list()) {
    if (adapter.credentialAdapterId === credAdapterId) return adapter
  }
  return undefined
}

router.post(
  '/projects/:pid/credentials/:credId/setup/start',
  requirePermission('credentials:write'),
  async (req, res) => {
    const projectId = req.params['pid']!
    const credentialId = req.params['credId']!

    const cred = await getCredentialById(credentialId)
    if (!cred) { res.status(404).json({ error: 'Credential not found' }); return }
    // Credentials use scope+scope_id (no project_id column). Project-scoped
    // creds must match this project; company-scoped pass through (caller's
    // permission was already validated by `requirePermission` middleware).
    if (cred.scope === 'project' && cred.scope_id !== projectId) {
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

    // Refresh credential data into the session — adapter reads these
    // (e.g. api_id, api_hash, phone_number) instead of importing db. Merge
    // BOTH columns: encrypted secrets (api_id, api_hash) AND plain metadata
    // (phone_number, user_id, etc). Adapter doesn't need to care which
    // column a field lives in — it just sees a flat `credential_fields`.
    const decrypted = cred.fields_encrypted ? decryptFields(cred.fields_encrypted) : {}
    const meta = (cred.metadata as Record<string, string> | null) ?? {}
    session.credential_fields = { ...meta, ...decrypted }

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
      // Split returned fields by adapter's credentialSchema: ones marked
      // `'secret|...'` go into `fields_encrypted` (AES-GCM), the rest land in
      // plain `metadata`. Without this split, non-secret display fields
      // (user_id, username, is_premium) would be stored encrypted unnecessarily
      // AND they wouldn't be queryable / inspectable from the metadata column
      // — UI badges that read metadata would miss them.
      const { zodSchemaToAdapterFields } = await import('../credentials/adapters.ts')
      const adapterFieldsSpec = adapter.credentialSchema
        ? zodSchemaToAdapterFields(adapter.credentialSchema)
        : { fields: [], metadata: [] }
      // AdapterField uses `key` (not `name`) — getting this wrong means every
      // field falls into the `else` branch and gets stored in plain metadata
      // INCLUDING session_string. That made onActivate fail with "No
      // session_string" right after a "successful" wizard.
      const secretNames = new Set(adapterFieldsSpec.fields.map(f => f.key))
      const metaNames = new Set(adapterFieldsSpec.metadata.map(f => f.key))

      // Existing values per column, merge-then-overwrite.
      const existingFields = cred.fields_encrypted ? decryptFields(cred.fields_encrypted) : {}
      const existingMeta = (cred.metadata as Record<string, string> | null) ?? {}
      const mergedFields: Record<string, string> = { ...existingFields }
      const mergedMeta: Record<string, string> = { ...existingMeta }

      for (const [k, v] of Object.entries(result.fields)) {
        const stringified = v === null || v === undefined ? '' : String(v)
        if (secretNames.has(k)) {
          mergedFields[k] = stringified
        } else if (metaNames.has(k)) {
          mergedMeta[k] = stringified
        } else {
          // Unknown key — adapter returned a field that's not in its own
          // credentialSchema. Store in metadata + warn (not fatal — adapter
          // might be ahead of its declared schema).
          console.warn(`[connector-setup] adapter "${adapter.id}" returned field "${k}" not declared in credentialSchema — storing in metadata`)
          mergedMeta[k] = stringified
        }
      }

      console.log(`[connector-setup] persisting credential=${credentialId} adapter=${adapter.id} secret_keys=[${Object.keys(mergedFields).join(',')}] metadata_keys=[${Object.keys(mergedMeta).join(',')}]`)
      await updateCredential(credentialId, {
        fields_encrypted: encryptFields(mergedFields),
        metadata: mergedMeta,
      })
      connectorSetupSessions.delete(sessionId)
      audit.credentialSetupCompleted(
        { ...auditContext(req), project_id: projectId },
        credentialId,
        { session_id: sessionId, step_id: body.step_id, persisted_field_count: Object.keys(result.fields).length, secret_count: Object.keys(result.fields).filter(k => secretNames.has(k)).length },
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
