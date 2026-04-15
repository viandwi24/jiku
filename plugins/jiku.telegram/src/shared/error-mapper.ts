import type { ConnectorSendResult } from '@jiku/types'

/**
 * Map an error thrown by the userbot queue into a structured ConnectorSendResult /
 * action-result envelope. The queue throws errors with `code` annotations
 * (FLOOD_WAIT, PEER_FLOOD_LATCHED, SESSION_EXPIRED) — translate to fields agents
 * + the route layer can read without parsing strings.
 */
export function mapQueueError(err: unknown): ConnectorSendResult & { code?: string; wait_seconds?: number; scope?: string } {
  const e = err as { code?: string; wait_seconds?: number; scope?: string; message?: string } | null
  const message = e?.message ?? (err instanceof Error ? err.message : String(err))
  if (e?.code === 'FLOOD_WAIT') {
    return { success: false, code: 'FLOOD_WAIT', wait_seconds: e.wait_seconds ?? 0, scope: e.scope ?? 'chat', error: message }
  }
  if (e?.code === 'PEER_FLOOD' || e?.code === 'PEER_FLOOD_LATCHED') {
    return { success: false, code: 'PEER_FLOOD', error: 'Session is spam-restricted by Telegram. Auto-send disabled until admin clears the latch.' }
  }
  if (e?.code === 'SESSION_EXPIRED') {
    return { success: false, code: 'SESSION_EXPIRED', error: 'Userbot session expired — re-run the Setup wizard on the credential.' }
  }
  return { success: false, error: message }
}
