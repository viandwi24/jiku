import { getConnectorById, getCredentialById, updateConnector } from '@jiku-studio/db'
import { decryptFields } from '../credentials/encryption.ts'
import { connectorRegistry } from './registry.ts'
import { routeConnectorEvent } from './event-router.ts'
import { connectorSseMap } from '../routes/connectors.ts'
import { runtimeManager } from '../runtime/manager.ts'
import type { ConnectorContext, ConnectorEvent } from '@jiku/types'

/**
 * Activate a connector: resolve credential, build ConnectorContext,
 * call adapter.onActivate(), mark status=active.
 */
export async function activateConnector(connectorId: string): Promise<void> {
  const connector = await getConnectorById(connectorId)
  if (!connector) throw new Error(`Connector not found: ${connectorId}`)

  const adapter = connectorRegistry.get(connector.plugin_id)
  if (!adapter) throw new Error(`Adapter not registered: ${connector.plugin_id}`)

  // Resolve credentials
  let fields: Record<string, string> = {}
  let metadata: Record<string, string> = {}

  if (connector.credential_id) {
    const cred = await getCredentialById(connector.credential_id)
    if (!cred) throw new Error(`Credential not found: ${connector.credential_id}`)
    if (cred.fields_encrypted) {
      fields = decryptFields(cred.fields_encrypted)
    }
    metadata = (cred.metadata ?? {}) as Record<string, string>
  }

  const ctx: ConnectorContext = {
    projectId: connector.project_id,
    connectorId,
    fields,
    metadata,
    onEvent: async (event: ConnectorEvent) => {
      // Broadcast to SSE listeners
      const listeners = connectorSseMap.get(connectorId)
      if (listeners && listeners.size > 0) {
        const data = JSON.stringify({ ...event, timestamp: event.timestamp.toISOString() })
        for (const res of listeners) res.write(`data: ${data}\n\n`)
      }
      // Route into pipeline
      await routeConnectorEvent(event, connector.project_id, runtimeManager)
    },
  }

  await adapter.onActivate(ctx)
  connectorRegistry.setActive(connectorId, adapter.id, connector.project_id)
  await updateConnector(connectorId, { status: 'active', error_message: null })
  console.log(`[connector] activated: ${connectorId} (${adapter.id})`)
}

/**
 * Deactivate a connector: call adapter.onDeactivate(), mark status=inactive.
 */
export async function deactivateConnector(connectorId: string): Promise<void> {
  const adapter = connectorRegistry.getAdapterForConnector(connectorId)
  if (adapter) {
    await adapter.onDeactivate(connectorId).catch(err =>
      console.warn(`[connector] deactivate error (${connectorId}):`, err)
    )
  }
  connectorRegistry.removeActive(connectorId)
  await updateConnector(connectorId, { status: 'inactive' })
  console.log(`[connector] deactivated: ${connectorId}`)
}
