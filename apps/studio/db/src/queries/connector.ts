import { eq, and, desc, sql } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  connectors,
  connector_bindings,
  connector_identities,
  connector_events,
  connector_messages,
  connector_message_events,
  connector_invite_codes,
  user_identities,
} from '../schema/connectors.ts'

// ─── Connectors ─────────────────────────────────────────────────────────────

export async function getConnectors(projectId: string) {
  return db
    .select()
    .from(connectors)
    .where(eq(connectors.project_id, projectId))
    .orderBy(desc(connectors.created_at))
}

export async function getConnectorById(id: string) {
  const rows = await db.select().from(connectors).where(eq(connectors.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createConnector(data: {
  project_id: string
  plugin_id: string
  display_name: string
  credential_id?: string | null
  config?: Record<string, unknown>
}) {
  const rows = await db
    .insert(connectors)
    .values({ ...data, config: data.config ?? {}, status: 'inactive' })
    .returning()
  return rows[0]!
}

export async function updateConnector(id: string, data: Partial<{
  display_name: string
  credential_id: string | null
  config: Record<string, unknown>
  status: string
  error_message: string | null
  match_mode: string
  default_agent_id: string | null
}>) {
  const rows = await db
    .update(connectors)
    .set({ ...data, updated_at: new Date() })
    .where(eq(connectors.id, id))
    .returning()
  return rows[0] ?? null
}

export async function deleteConnector(id: string) {
  await db.delete(connectors).where(eq(connectors.id, id))
}

// ─── Bindings ────────────────────────────────────────────────────────────────

export async function getBindings(connectorId: string) {
  return db
    .select()
    .from(connector_bindings)
    .where(eq(connector_bindings.connector_id, connectorId))
    .orderBy(desc(connector_bindings.created_at))
}

export async function getBindingById(id: string) {
  const rows = await db.select().from(connector_bindings).where(eq(connector_bindings.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getActiveBindingsForProject(projectId: string) {
  return db
    .select({ binding: connector_bindings, connector: connectors })
    .from(connector_bindings)
    .innerJoin(connectors, eq(connector_bindings.connector_id, connectors.id))
    .where(
      and(
        eq(connectors.project_id, projectId),
        eq(connector_bindings.enabled, true),
        eq(connectors.status, 'active'),
      )
    )
}

export async function createBinding(data: {
  connector_id: string
  display_name?: string
  source_type?: string
  source_ref_keys?: Record<string, string>
  trigger_source?: string
  trigger_mode?: string
  trigger_keywords?: string[]
  trigger_event_type?: string
  trigger_event_filter?: Record<string, unknown>
  output_adapter?: string
  output_config?: Record<string, unknown>
  rate_limit_rpm?: number
  include_sender_info?: boolean
  priority?: number
  trigger_regex?: string
  schedule_filter?: Record<string, unknown>
}) {
  const rows = await db
    .insert(connector_bindings)
    .values({
      ...data,
      source_type: data.source_type ?? 'any',
      trigger_source: data.trigger_source ?? 'message',
      trigger_mode: data.trigger_mode ?? 'always',
      output_adapter: data.output_adapter ?? 'conversation',
      output_config: data.output_config ?? {},
      include_sender_info: data.include_sender_info ?? true,
    })
    .returning()
  return rows[0]!
}

export async function updateBinding(id: string, data: Partial<{
  display_name: string
  source_type: string
  source_ref_keys: Record<string, string>
  trigger_source: string
  trigger_mode: string
  trigger_keywords: string[]
  trigger_event_type: string
  trigger_event_filter: Record<string, unknown>
  output_adapter: string
  output_config: Record<string, unknown>
  rate_limit_rpm: number
  include_sender_info: boolean
  enabled: boolean
  priority: number
  trigger_regex: string
  schedule_filter: Record<string, unknown>
}>) {
  const rows = await db
    .update(connector_bindings)
    .set(data)
    .where(eq(connector_bindings.id, id))
    .returning()
  return rows[0] ?? null
}

export async function deleteBinding(id: string) {
  await db.delete(connector_bindings).where(eq(connector_bindings.id, id))
}

// ─── Identities ───────────────────────────────────────────────────────────────

export async function getIdentitiesForBinding(bindingId: string) {
  return db
    .select()
    .from(connector_identities)
    .where(eq(connector_identities.binding_id, bindingId))
    .orderBy(desc(connector_identities.created_at))
}

export async function getPairingRequestsForConnector(connectorId: string) {
  return db
    .select()
    .from(connector_identities)
    .where(
      and(
        eq(connector_identities.connector_id, connectorId),
        sql`${connector_identities.binding_id} is null`,
      )
    )
    .orderBy(desc(connector_identities.created_at))
}

export async function findIdentityByExternalId(connectorId: string, externalUserId: string) {
  const rows = await db
    .select()
    .from(connector_identities)
    .where(
      and(
        eq(connector_identities.connector_id, connectorId),
        sql`${connector_identities.external_ref_keys}->>'user_id' = ${externalUserId}`,
      )
    )
    .limit(1)
  return rows[0] ?? null
}

export async function createIdentity(data: {
  connector_id: string
  binding_id?: string | null
  external_ref_keys: Record<string, string>
  display_name?: string
  avatar_url?: string
  status?: string
}) {
  const rows = await db
    .insert(connector_identities)
    .values({ ...data, binding_id: data.binding_id ?? null, status: data.status ?? 'pending' })
    .returning()
  return rows[0]!
}

export async function updateIdentity(id: string, data: Partial<{
  binding_id: string | null
  display_name: string
  avatar_url: string
  status: string
  approved_by: string
  approved_at: Date
  mapped_user_id: string
  conversation_id: string
  last_seen_at: Date
}>) {
  const rows = await db
    .update(connector_identities)
    .set(data)
    .where(eq(connector_identities.id, id))
    .returning()
  return rows[0] ?? null
}

// ─── Events ──────────────────────────────────────────────────────────────────

export async function logConnectorEvent(data: {
  connector_id: string
  binding_id?: string
  identity_id?: string
  event_type: string
  ref_keys: Record<string, string>
  target_ref_keys?: Record<string, string>
  payload: Record<string, unknown>
  metadata?: Record<string, unknown>
  status?: string
  drop_reason?: string
  processing_ms?: number
}) {
  const rows = await db
    .insert(connector_events)
    .values({ ...data, status: data.status ?? 'received' })
    .returning()
  return rows[0]!
}

export async function getConnectorEvents(connectorId: string, limit = 50) {
  return db
    .select()
    .from(connector_events)
    .where(eq(connector_events.connector_id, connectorId))
    .orderBy(desc(connector_events.created_at))
    .limit(limit)
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function logConnectorMessage(data: {
  connector_id: string
  conversation_id?: string
  direction: string
  ref_keys: Record<string, string>
  content_snapshot?: string
  status?: string
}) {
  const rows = await db
    .insert(connector_messages)
    .values({ ...data, status: data.status ?? 'sent' })
    .returning()
  return rows[0]!
}

export async function getConnectorMessages(connectorId: string, limit = 50) {
  return db
    .select()
    .from(connector_messages)
    .where(eq(connector_messages.connector_id, connectorId))
    .orderBy(desc(connector_messages.created_at))
    .limit(limit)
}

export async function logConnectorMessageEvent(data: {
  connector_message_id: string
  connector_event_id?: string
  event_type: string
  actor_ref_keys?: Record<string, string>
  actor_display_name?: string
  payload?: Record<string, unknown>
}) {
  const rows = await db
    .insert(connector_message_events)
    .values(data)
    .returning()
  return rows[0]!
}

// ─── User Identities ─────────────────────────────────────────────────────────

export async function getUserIdentities(userId: string, projectId: string, keys?: string[]) {
  const conditions = [
    eq(user_identities.user_id, userId),
    eq(user_identities.project_id, projectId),
  ]

  if (keys && keys.length > 0) {
    // Filter by keys (manual check since inArray needs import)
    const rows = await db
      .select()
      .from(user_identities)
      .where(and(...conditions))
    return rows.filter(r => keys.includes(r.key))
  }

  return db.select().from(user_identities).where(and(...conditions))
}

export async function upsertUserIdentity(data: {
  user_id: string
  project_id: string
  key: string
  value: string
  label?: string
  source?: string
  visibility?: string
}) {
  const rows = await db
    .insert(user_identities)
    .values({
      ...data,
      source: data.source ?? 'user',
      visibility: data.visibility ?? 'project',
    })
    .onConflictDoUpdate({
      target: [user_identities.user_id, user_identities.project_id, user_identities.key],
      set: {
        value: data.value,
        label: data.label,
        source: data.source ?? 'user',
        updated_at: new Date(),
      },
    })
    .returning()
  return rows[0]!
}

export async function deleteUserIdentity(userId: string, projectId: string, key: string) {
  await db.delete(user_identities).where(
    and(
      eq(user_identities.user_id, userId),
      eq(user_identities.project_id, projectId),
      eq(user_identities.key, key),
    )
  )
}

export async function findUserByIdentity(projectId: string, key: string, value: string) {
  return db
    .select()
    .from(user_identities)
    .where(
      and(
        eq(user_identities.project_id, projectId),
        eq(user_identities.key, key),
        eq(user_identities.value, value),
      )
    )
    .limit(10)
}

// ─── Invite Codes ────────────────────────────────────────────────────────────

export async function getInviteCodesForConnector(connectorId: string) {
  return db
    .select()
    .from(connector_invite_codes)
    .where(eq(connector_invite_codes.connector_id, connectorId))
    .orderBy(desc(connector_invite_codes.created_at))
}

export async function getInviteCodeByCode(code: string) {
  const rows = await db
    .select()
    .from(connector_invite_codes)
    .where(eq(connector_invite_codes.code, code))
    .limit(1)
  return rows[0] ?? null
}

export async function createInviteCode(data: {
  connector_id: string
  code: string
  label?: string | null
  max_uses?: number | null
  expires_at?: Date | null
  created_by?: string | null
}) {
  const [row] = await db
    .insert(connector_invite_codes)
    .values({
      connector_id: data.connector_id,
      code: data.code,
      label: data.label ?? null,
      max_uses: data.max_uses ?? null,
      expires_at: data.expires_at ?? null,
      created_by: data.created_by ?? null,
    })
    .returning()
  return row!
}

export async function revokeInviteCode(id: string) {
  const [row] = await db
    .update(connector_invite_codes)
    .set({ revoked: true })
    .where(eq(connector_invite_codes.id, id))
    .returning()
  return row ?? null
}

export async function deleteInviteCode(id: string) {
  await db.delete(connector_invite_codes).where(eq(connector_invite_codes.id, id))
}

/**
 * Attempt to redeem an invite code.
 * Returns the connector_id if successful, or null if invalid/expired/exhausted.
 * Increments use_count atomically.
 */
export async function redeemInviteCode(code: string): Promise<string | null> {
  const invite = await getInviteCodeByCode(code)
  if (!invite) return null
  if (invite.revoked) return null
  if (invite.expires_at && invite.expires_at < new Date()) return null
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) return null

  await db
    .update(connector_invite_codes)
    .set({ use_count: sql`${connector_invite_codes.use_count} + 1` })
    .where(eq(connector_invite_codes.id, invite.id))

  return invite.connector_id
}
