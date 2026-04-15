/**
 * Plan 25 Phase 4 — `outbound_approval` destination handler.
 *
 * When an AR with destination_type='outbound_approval' transitions to:
 *   - approved → re-resolve the connector adapter and call sendMessage with the
 *               original payload stored in destination_ref.content.
 *   - rejected → no-op (the message is dropped silently from the operator side;
 *               the agent already saw `queued: true` from the original
 *               connector_send call and will see status='rejected' if it
 *               action_request.wait()s).
 *
 * Type-constraint (validated at create time): only AR type='boolean' is allowed
 * for this destination.
 */
import { connectorRegistry } from '../connectors/registry.ts'
import { logConnectorMessage, logConnectorEvent } from '@jiku-studio/db'
import { broadcastProjectEvent, broadcastProjectMessage } from '../connectors/sse-hub.ts'
import { registerDestinationHandler } from './destinations.ts'

export function registerOutboundApprovalHandler(): void {
  registerDestinationHandler('outbound_approval', async ({ action_request }) => {
    if (action_request.status !== 'approved') {
      // rejected → silent drop. The agent's wait() resolves with status=rejected.
      return
    }
    const ref = action_request.destination_ref as
      | { kind: 'outbound_approval'; connector_id: string; target: { ref_keys: Record<string, string>; reply_to_ref_keys?: Record<string, string> }; content: { text: string; markdown?: boolean; simulate_typing?: boolean; params?: Record<string, unknown> } }
      | { kind: 'outbound_approval'; connector_id: string; action_id: string; params: Record<string, unknown> }
      | null
    if (!ref) throw new Error('outbound_approval AR missing destination_ref')

    const adapter = connectorRegistry.getAdapterForConnector(ref.connector_id)
    if (!adapter) throw new Error(`Connector ${ref.connector_id} not active — cannot send approved message`)

    // Polymorphic dispatch: action-shaped ref → runAction; otherwise sendMessage.
    if ('action_id' in ref) {
      if (!adapter.runAction) throw new Error(`Connector ${adapter.id} does not support actions`)
      const actionResult = await adapter.runAction(ref.action_id, ref.params, ref.connector_id)
      const success = (actionResult as { success?: boolean })?.success !== false
      if (!success) throw new Error(`Adapter runAction failed: ${(actionResult as { error?: string })?.error ?? 'unknown error'}`)
      const evRow = await logConnectorEvent({
        connector_id: ref.connector_id,
        event_type: ref.action_id,
        direction: 'outbound',
        ref_keys: (ref.params['target_ref_keys'] as Record<string, string>) ?? {},
        payload: { ...ref.params, via: 'action_request', action_request_id: action_request.id },
        raw_payload: actionResult,
        status: 'routed',
      }).catch(() => null)
      if (evRow) broadcastProjectEvent(action_request.project_id, evRow as unknown as Record<string, unknown>)
      return
    }

    const sendResult = await adapter.sendMessage(
      { ref_keys: ref.target.ref_keys, reply_to_ref_keys: ref.target.reply_to_ref_keys, connector_id: ref.connector_id },
      {
        text: ref.content.text,
        markdown: ref.content.markdown ?? true,
        simulate_typing: ref.content.simulate_typing ?? false,
        params: ref.content.params,
      },
    )
    if (!sendResult.success) {
      throw new Error(`Adapter sendMessage failed: ${sendResult.error ?? 'unknown error'}`)
    }

    // Mirror connector_send tool's logging so the channel UI sees the outbound
    // message and event after the approved AR fires.
    const msgRow = await logConnectorMessage({
      connector_id: ref.connector_id,
      direction: 'outbound',
      ref_keys: sendResult.ref_keys ?? ref.target.ref_keys,
      content_snapshot: ref.content.text,
      raw_payload: sendResult,
      status: 'sent',
    }).catch(() => null)
    if (msgRow) broadcastProjectMessage(action_request.project_id, msgRow as unknown as Record<string, unknown>)
    const evRow = await logConnectorEvent({
      connector_id: ref.connector_id,
      event_type: 'send_message',
      direction: 'outbound',
      ref_keys: sendResult.ref_keys ?? ref.target.ref_keys,
      target_ref_keys: ref.target.reply_to_ref_keys,
      payload: { text: ref.content.text, via: 'action_request', action_request_id: action_request.id },
      raw_payload: sendResult,
      status: 'routed',
    }).catch(() => null)
    if (evRow) broadcastProjectEvent(action_request.project_id, evRow as unknown as Record<string, unknown>)
  })
}
