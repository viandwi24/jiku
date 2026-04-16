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
  // mtcute throws "Peer X is not found in local cache" when the peer access_hash
  // isn't in the SQLite storage. For userbot, the peer must have been seen in
  // this session (received a message from / sent a message to / appeared in dialogs).
  // Common agent-side mistake: passing a sender's user_id as `from_chat_id` for a
  // message that lived in a group — the chat_id of a group message is the group
  // id (negative number, e.g. -100xxxxxxxxxx), not the sender. Or passing a stale
  // id from before a session reset.
  if (/not found in (local )?cache|PEER_ID_INVALID/i.test(message)) {
    return {
      success: false,
      code: 'PEER_NOT_CACHED',
      error: `Telegram peer access hash not in userbot cache: ${message}. Common causes: (1) chat_id refers to a peer the userbot has never interacted with — verify it's the chat_id where the message lives, NOT a sender's user_id from a group; (2) the userbot session was re-set up and the cache was wiped — call get_dialogs first to repopulate, or have the peer message the userbot once.`,
    }
  }
  return { success: false, error: message }
}
