import { eq, and, desc, sql, gte, lte } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  connectors,
  connector_bindings,
  connector_identities,
  connector_events,
  connector_messages,
  connector_message_events,
  connector_invite_codes,
  connector_scope_conversations,
  connector_targets,
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
  outbound_approval: { mode: 'none' | 'always' | 'tagged'; default_expires_in_seconds?: number }
  log_mode: 'all' | 'active_binding_only'
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

// Pending group-pairing drafts: bindings auto-created when the bot was added
// to a group but no admin has picked an agent for them yet. Heuristic:
// enabled=false AND output_config has no `agent_id`. Admin approves via the
// group-pairings UI → fills in agent_id + member_mode + flips enabled=true.
export async function getPendingGroupPairings(connectorId: string) {
  const rows = await db
    .select()
    .from(connector_bindings)
    .where(and(
      eq(connector_bindings.connector_id, connectorId),
      eq(connector_bindings.enabled, false),
    ))
    .orderBy(desc(connector_bindings.created_at))
  return rows.filter(b => {
    const agentId = (b.output_config as Record<string, unknown> | null)?.['agent_id']
    return !agentId
  })
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
  trigger_keywords_regex?: boolean
  trigger_mention_tokens?: string[]
  trigger_commands?: string[]
  trigger_event_type?: string
  trigger_event_filter?: Record<string, unknown>
  output_adapter?: string
  output_config?: Record<string, unknown>
  rate_limit_rpm?: number
  include_sender_info?: boolean
  priority?: number
  trigger_regex?: string
  schedule_filter?: Record<string, unknown>
  scope_key_pattern?: string | null
  member_mode?: 'require_approval' | 'allow_all'
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
  trigger_keywords_regex: boolean
  trigger_mention_tokens: string[] | null
  trigger_commands: string[] | null
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
  scope_key_pattern: string | null
  member_mode: 'require_approval' | 'allow_all'
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

/**
 * Debug / admin endpoint feed — return ALL identities for a connector,
 * regardless of status (pending / approved / blocked / orphan) or binding
 * state. Lets the operator see history of pairing requests + force-reset
 * stuck rows. Sorted newest first.
 */
export async function getAllIdentitiesForConnector(connectorId: string) {
  return db
    .select()
    .from(connector_identities)
    .where(eq(connector_identities.connector_id, connectorId))
    .orderBy(desc(connector_identities.created_at))
}

export async function getIdentitiesForBinding(bindingId: string) {
  return db
    .select()
    .from(connector_identities)
    .where(eq(connector_identities.binding_id, bindingId))
    .orderBy(desc(connector_identities.created_at))
}

export async function getPairingRequestsForConnector(connectorId: string) {
  // Only surface identities that are actually pending and not yet bound.
  // Previously this filtered on `binding_id IS NULL` only — after an admin
  // rejected a request (status → 'blocked'), the row stayed in the list
  // because binding_id was still null, so the UI "Reject" button appeared to
  // do nothing.
  return db
    .select()
    .from(connector_identities)
    .where(
      and(
        eq(connector_identities.connector_id, connectorId),
        sql`${connector_identities.binding_id} is null`,
        eq(connector_identities.status, 'pending'),
      )
    )
    .orderBy(desc(connector_identities.created_at))
}

export async function getIdentityById(id: string) {
  const rows = await db.select().from(connector_identities).where(eq(connector_identities.id, id)).limit(1)
  return rows[0] ?? null
}

/** Blocked / rejected identities on a connector — for admin cleanup UI. */
export async function getBlockedIdentitiesForConnector(connectorId: string) {
  return db
    .select()
    .from(connector_identities)
    .where(and(
      eq(connector_identities.connector_id, connectorId),
      eq(connector_identities.status, 'blocked'),
    ))
    .orderBy(desc(connector_identities.created_at))
}

/** Hard-delete an identity row. Use with care — the external user will have to
 *  re-pair from scratch if they DM the bot again. Safe here because a blocked
 *  identity has no binding attached and no live conversations. */
export async function deleteIdentity(id: string) {
  await db.delete(connector_identities).where(eq(connector_identities.id, id))
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
  direction?: 'inbound' | 'outbound'
  ref_keys: Record<string, string>
  target_ref_keys?: Record<string, string>
  payload: Record<string, unknown>
  raw_payload?: unknown
  metadata?: Record<string, unknown>
  status?: string
  drop_reason?: string
  processing_ms?: number
}) {
  const rows = await db
    .insert(connector_events)
    .values({ ...data, direction: data.direction ?? 'inbound', status: data.status ?? 'received' })
    .returning()
  return rows[0]!
}

export async function getConnectorEventById(id: string) {
  const rows = await db.select().from(connector_events).where(eq(connector_events.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getConnectorMessageById(id: string) {
  const rows = await db.select().from(connector_messages).where(eq(connector_messages.id, id)).limit(1)
  return rows[0] ?? null
}

/** Project-scoped variants — agent tools should go through these so they can't
 * read rows outside their project even if someone guesses a UUID. */
export async function getProjectConnectorEventById(projectId: string, id: string) {
  const rows = await db
    .select({ ev: connector_events, connector: connectors })
    .from(connector_events)
    .innerJoin(connectors, eq(connector_events.connector_id, connectors.id))
    .where(and(eq(connectors.project_id, projectId), eq(connector_events.id, id)))
    .limit(1)
  if (!rows[0]) return null
  return {
    ...rows[0].ev,
    connector_name: rows[0].connector.display_name,
    connector_plugin_id: rows[0].connector.plugin_id,
  }
}

export async function getProjectConnectorMessageById(projectId: string, id: string) {
  const rows = await db
    .select({ msg: connector_messages, connector: connectors })
    .from(connector_messages)
    .innerJoin(connectors, eq(connector_messages.connector_id, connectors.id))
    .where(and(eq(connectors.project_id, projectId), eq(connector_messages.id, id)))
    .limit(1)
  if (!rows[0]) return null
  return {
    ...rows[0].msg,
    connector_name: rows[0].connector.display_name,
    connector_plugin_id: rows[0].connector.plugin_id,
  }
}

export async function getConnectorEvents(
  connectorId: string,
  limit = 50,
  opts?: { direction?: 'inbound' | 'outbound'; event_type?: string },
) {
  const conds = [eq(connector_events.connector_id, connectorId)]
  if (opts?.direction) conds.push(eq(connector_events.direction, opts.direction))
  if (opts?.event_type) conds.push(eq(connector_events.event_type, opts.event_type))
  return db
    .select()
    .from(connector_events)
    .where(and(...conds))
    .orderBy(desc(connector_events.created_at))
    .limit(limit)
}

// Keyset-paginated events scoped to a project (joins connectors for project_id filter)
export interface ListConnectorEventsOptions {
  project_id: string
  connector_id?: string
  event_type?: string
  direction?: 'inbound' | 'outbound'
  status?: string
  chat_id?: string
  thread_id?: string
  user_id?: string          // external sender id (from event.sender.external_id / payload.sender.external_id)
  content_search?: string   // case-insensitive substring match against payload.content.text
  from?: Date
  to?: Date
  cursor?: { created_at: Date; id: string } | null
  limit?: number
}

export async function listConnectorEventsForProject(opts: ListConnectorEventsOptions) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const conds = [eq(connectors.project_id, opts.project_id)]
  if (opts.connector_id) conds.push(eq(connector_events.connector_id, opts.connector_id))
  if (opts.event_type) conds.push(eq(connector_events.event_type, opts.event_type))
  if (opts.direction) conds.push(eq(connector_events.direction, opts.direction))
  if (opts.status) conds.push(eq(connector_events.status, opts.status))
  if (opts.chat_id) conds.push(sql`${connector_events.ref_keys}->>'chat_id' = ${opts.chat_id}`)
  if (opts.thread_id) conds.push(sql`${connector_events.ref_keys}->>'thread_id' = ${opts.thread_id}`)
  if (opts.user_id) conds.push(sql`${connector_events.payload}->'sender'->>'external_id' = ${opts.user_id}`)
  if (opts.content_search) {
    conds.push(sql`${connector_events.payload}->'content'->>'text' ILIKE ${'%' + opts.content_search + '%'}`)
  }
  if (opts.from) conds.push(gte(connector_events.created_at, opts.from))
  if (opts.to) conds.push(lte(connector_events.created_at, opts.to))
  if (opts.cursor) {
    conds.push(sql`(${connector_events.created_at}, ${connector_events.id}) < (${opts.cursor.created_at.toISOString()}::timestamp, ${opts.cursor.id}::uuid)`)
  }

  const rows = await db
    .select({
      id: connector_events.id,
      connector_id: connector_events.connector_id,
      binding_id: connector_events.binding_id,
      identity_id: connector_events.identity_id,
      event_type: connector_events.event_type,
      direction: connector_events.direction,
      ref_keys: connector_events.ref_keys,
      target_ref_keys: connector_events.target_ref_keys,
      payload: connector_events.payload,
      raw_payload: connector_events.raw_payload,
      metadata: connector_events.metadata,
      status: connector_events.status,
      drop_reason: connector_events.drop_reason,
      processing_ms: connector_events.processing_ms,
      created_at: connector_events.created_at,
      connector_name: connectors.display_name,
    })
    .from(connector_events)
    .innerJoin(connectors, eq(connector_events.connector_id, connectors.id))
    .where(and(...conds))
    .orderBy(desc(connector_events.created_at), desc(connector_events.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  const next_cursor = hasMore && last
    ? { created_at: last.created_at, id: last.id }
    : null
  return { items, next_cursor }
}

// Distinct-entity aggregation over events — lets the agent discover which
// chats / users / threads exist on a connector without paging through every
// row. Each row returns the entity key, count, last_seen, and a best-effort
// label (for chats: latest chat_title from metadata; for users: sender
// display_name or username).
export interface DistinctEntitiesOptions {
  project_id: string
  connector_id?: string
  scope: 'chats' | 'users' | 'threads'
  limit?: number
}

export async function listConnectorDistinctEntities(opts: DistinctEntitiesOptions) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const connectorCond = opts.connector_id
    ? sql`AND ${connector_events.connector_id} = ${opts.connector_id}::uuid`
    : sql``

  if (opts.scope === 'chats') {
    const rows = await db.execute(sql`
      SELECT
        ${connector_events.ref_keys}->>'chat_id' AS entity_id,
        COUNT(*)::int AS event_count,
        MAX(${connector_events.created_at}) AS last_seen_at,
        (array_agg(${connector_events.metadata}->>'chat_title' ORDER BY ${connector_events.created_at} DESC) FILTER (WHERE ${connector_events.metadata}->>'chat_title' IS NOT NULL))[1] AS label,
        (array_agg(${connector_events.metadata}->>'chat_type' ORDER BY ${connector_events.created_at} DESC) FILTER (WHERE ${connector_events.metadata}->>'chat_type' IS NOT NULL))[1] AS chat_type
      FROM ${connector_events}
      INNER JOIN ${connectors} ON ${connector_events.connector_id} = ${connectors.id}
      WHERE ${connectors.project_id} = ${opts.project_id}::uuid
        AND ${connector_events.ref_keys}->>'chat_id' IS NOT NULL
        ${connectorCond}
      GROUP BY entity_id
      ORDER BY last_seen_at DESC
      LIMIT ${limit}
    `)
    return rows.map((r: Record<string, unknown>) => ({
      entity_id: r['entity_id'] as string,
      label: (r['label'] as string | null) ?? null,
      chat_type: (r['chat_type'] as string | null) ?? null,
      event_count: r['event_count'] as number,
      last_seen_at: r['last_seen_at'] as Date,
    }))
  }

  if (opts.scope === 'users') {
    const rows = await db.execute(sql`
      SELECT
        ${connector_events.payload}->'sender'->>'external_id' AS entity_id,
        COUNT(*)::int AS event_count,
        MAX(${connector_events.created_at}) AS last_seen_at,
        (array_agg(${connector_events.payload}->'sender'->>'display_name' ORDER BY ${connector_events.created_at} DESC) FILTER (WHERE ${connector_events.payload}->'sender'->>'display_name' IS NOT NULL))[1] AS label,
        (array_agg(${connector_events.payload}->'sender'->>'username' ORDER BY ${connector_events.created_at} DESC) FILTER (WHERE ${connector_events.payload}->'sender'->>'username' IS NOT NULL))[1] AS username
      FROM ${connector_events}
      INNER JOIN ${connectors} ON ${connector_events.connector_id} = ${connectors.id}
      WHERE ${connectors.project_id} = ${opts.project_id}::uuid
        AND ${connector_events.payload}->'sender'->>'external_id' IS NOT NULL
        ${connectorCond}
      GROUP BY entity_id
      ORDER BY last_seen_at DESC
      LIMIT ${limit}
    `)
    return rows.map((r: Record<string, unknown>) => ({
      entity_id: r['entity_id'] as string,
      label: (r['label'] as string | null) ?? null,
      username: (r['username'] as string | null) ?? null,
      event_count: r['event_count'] as number,
      last_seen_at: r['last_seen_at'] as Date,
    }))
  }

  // scope === 'threads'
  const rows = await db.execute(sql`
    SELECT
      ${connector_events.ref_keys}->>'chat_id' AS chat_id,
      ${connector_events.ref_keys}->>'thread_id' AS thread_id,
      COUNT(*)::int AS event_count,
      MAX(${connector_events.created_at}) AS last_seen_at,
      (array_agg(${connector_events.metadata}->>'chat_title' ORDER BY ${connector_events.created_at} DESC) FILTER (WHERE ${connector_events.metadata}->>'chat_title' IS NOT NULL))[1] AS chat_label,
      (array_agg(${connector_events.metadata}->>'thread_title' ORDER BY ${connector_events.created_at} DESC) FILTER (WHERE ${connector_events.metadata}->>'thread_title' IS NOT NULL))[1] AS thread_label
    FROM ${connector_events}
    INNER JOIN ${connectors} ON ${connector_events.connector_id} = ${connectors.id}
    WHERE ${connectors.project_id} = ${opts.project_id}::uuid
      AND ${connector_events.ref_keys}->>'thread_id' IS NOT NULL
      ${connectorCond}
    GROUP BY chat_id, thread_id
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `)
  return rows.map((r: Record<string, unknown>) => ({
    chat_id: r['chat_id'] as string,
    thread_id: r['thread_id'] as string,
    chat_label: (r['chat_label'] as string | null) ?? null,
    thread_label: (r['thread_label'] as string | null) ?? null,
    event_count: r['event_count'] as number,
    last_seen_at: r['last_seen_at'] as Date,
  }))
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * Plan 25 add-on — lookup a previously-logged inbound message by its external
 * platform refs (chat_id + message_id). Used to walk reply chains for the
 * connector_context block. Returns null if not in cache.
 */
export async function getConnectorMessageByExternalRef(
  connectorId: string,
  chatId: string,
  messageId: string,
) {
  const rows = await db
    .select()
    .from(connector_messages)
    .where(and(
      eq(connector_messages.connector_id, connectorId),
      sql`${connector_messages.ref_keys}->>'chat_id' = ${chatId}`,
      sql`${connector_messages.ref_keys}->>'message_id' = ${messageId}`,
    ))
    .limit(1)
  return rows[0] ?? null
}

export async function logConnectorMessage(data: {
  connector_id: string
  conversation_id?: string
  direction: string
  ref_keys: Record<string, string>
  content_snapshot?: string
  raw_payload?: unknown
  status?: string
}) {
  const rows = await db
    .insert(connector_messages)
    .values({ ...data, status: data.status ?? 'sent' })
    .returning()
  return rows[0]!
}

export async function getConnectorMessages(
  connectorId: string,
  limit = 50,
  opts?: { direction?: 'inbound' | 'outbound' },
) {
  const conds = [eq(connector_messages.connector_id, connectorId)]
  if (opts?.direction) conds.push(eq(connector_messages.direction, opts.direction))
  return db
    .select()
    .from(connector_messages)
    .where(and(...conds))
    .orderBy(desc(connector_messages.created_at))
    .limit(limit)
}

export interface ListConnectorMessagesOptions {
  project_id: string
  connector_id?: string
  direction?: 'inbound' | 'outbound'
  status?: string
  chat_id?: string
  thread_id?: string
  content_search?: string   // ILIKE against content_snapshot
  from?: Date
  to?: Date
  cursor?: { created_at: Date; id: string } | null
  limit?: number
}

export async function listConnectorMessagesForProject(opts: ListConnectorMessagesOptions) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const conds = [eq(connectors.project_id, opts.project_id)]
  if (opts.connector_id) conds.push(eq(connector_messages.connector_id, opts.connector_id))
  if (opts.direction) conds.push(eq(connector_messages.direction, opts.direction))
  if (opts.status) conds.push(eq(connector_messages.status, opts.status))
  if (opts.chat_id) conds.push(sql`${connector_messages.ref_keys}->>'chat_id' = ${opts.chat_id}`)
  if (opts.thread_id) conds.push(sql`${connector_messages.ref_keys}->>'thread_id' = ${opts.thread_id}`)
  if (opts.content_search) {
    conds.push(sql`${connector_messages.content_snapshot} ILIKE ${'%' + opts.content_search + '%'}`)
  }
  if (opts.from) conds.push(gte(connector_messages.created_at, opts.from))
  if (opts.to) conds.push(lte(connector_messages.created_at, opts.to))
  if (opts.cursor) {
    conds.push(sql`(${connector_messages.created_at}, ${connector_messages.id}) < (${opts.cursor.created_at.toISOString()}::timestamp, ${opts.cursor.id}::uuid)`)
  }

  const rows = await db
    .select({
      id: connector_messages.id,
      connector_id: connector_messages.connector_id,
      conversation_id: connector_messages.conversation_id,
      direction: connector_messages.direction,
      ref_keys: connector_messages.ref_keys,
      content_snapshot: connector_messages.content_snapshot,
      raw_payload: connector_messages.raw_payload,
      status: connector_messages.status,
      created_at: connector_messages.created_at,
      connector_name: connectors.display_name,
    })
    .from(connector_messages)
    .innerJoin(connectors, eq(connector_messages.connector_id, connectors.id))
    .where(and(...conds))
    .orderBy(desc(connector_messages.created_at), desc(connector_messages.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  const next_cursor = hasMore && last
    ? { created_at: last.created_at, id: last.id }
    : null
  return { items, next_cursor }
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

// ─── Scope Conversations (Plan 22) ───────────────────────────────────────────

export async function getScopeConversation(connectorId: string, scopeKey: string, agentId: string | null) {
  const conditions = [
    eq(connector_scope_conversations.connector_id, connectorId),
    eq(connector_scope_conversations.scope_key, scopeKey),
  ]
  if (agentId) conditions.push(eq(connector_scope_conversations.agent_id, agentId))
  else conditions.push(sql`${connector_scope_conversations.agent_id} is null`)

  const rows = await db
    .select()
    .from(connector_scope_conversations)
    .where(and(...conditions))
    .limit(1)
  return rows[0] ?? null
}

export async function createScopeConversation(data: {
  connector_id: string
  scope_key: string
  agent_id?: string | null
  conversation_id?: string | null
}) {
  const rows = await db
    .insert(connector_scope_conversations)
    .values({
      connector_id: data.connector_id,
      scope_key: data.scope_key,
      agent_id: data.agent_id ?? null,
      conversation_id: data.conversation_id ?? null,
    })
    .returning()
  return rows[0]!
}

export async function touchScopeConversation(id: string) {
  await db
    .update(connector_scope_conversations)
    .set({ last_activity_at: new Date() })
    .where(eq(connector_scope_conversations.id, id))
}

export async function setScopeConversationId(id: string, conversationId: string) {
  await db
    .update(connector_scope_conversations)
    .set({ conversation_id: conversationId, last_activity_at: new Date() })
    .where(eq(connector_scope_conversations.id, id))
}

export async function getConnectorScopes(connectorId: string, limit = 20) {
  return db
    .select()
    .from(connector_scope_conversations)
    .where(eq(connector_scope_conversations.connector_id, connectorId))
    .orderBy(desc(connector_scope_conversations.last_activity_at))
    .limit(limit)
}

// ─── Channel Targets (Plan 22) ───────────────────────────────────────────────

export async function getConnectorTargets(projectId: string, connectorId?: string) {
  const conditions = [eq(connectors.project_id, projectId)]
  if (connectorId) conditions.push(eq(connector_targets.connector_id, connectorId))

  const rows = await db
    .select({ target: connector_targets })
    .from(connector_targets)
    .innerJoin(connectors, eq(connector_targets.connector_id, connectors.id))
    .where(and(...conditions))
    .orderBy(desc(connector_targets.created_at))
  return rows.map(r => r.target)
}

// Enriched variant — returns the target together with its connector metadata
// so callers (agent tools, UI) don't need a second round-trip to know which
// adapter / bot owns the target.
export async function getConnectorTargetsEnriched(projectId: string, connectorId?: string) {
  const conditions = [eq(connectors.project_id, projectId)]
  if (connectorId) conditions.push(eq(connector_targets.connector_id, connectorId))

  const rows = await db
    .select({ target: connector_targets, connector: connectors })
    .from(connector_targets)
    .innerJoin(connectors, eq(connector_targets.connector_id, connectors.id))
    .where(and(...conditions))
    .orderBy(desc(connector_targets.created_at))
  return rows
}

export async function getConnectorTargetById(id: string) {
  const rows = await db.select().from(connector_targets).where(eq(connector_targets.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getConnectorTargetByName(projectId: string, name: string, connectorId?: string) {
  const conditions = [
    eq(connectors.project_id, projectId),
    eq(connector_targets.name, name),
  ]
  if (connectorId) conditions.push(eq(connector_targets.connector_id, connectorId))

  const rows = await db
    .select({ target: connector_targets })
    .from(connector_targets)
    .innerJoin(connectors, eq(connector_targets.connector_id, connectors.id))
    .where(and(...conditions))
    .limit(1)
  return rows[0]?.target ?? null
}

// Plural lookup — returns every target matching the name across the project
// (optionally filtered by connector). Callers use this to detect ambiguity
// (same name registered on multiple connectors) so the agent can be told to
// disambiguate by passing connector_id.
export async function getConnectorTargetsByName(projectId: string, name: string, connectorId?: string) {
  const conditions = [
    eq(connectors.project_id, projectId),
    eq(connector_targets.name, name),
  ]
  if (connectorId) conditions.push(eq(connector_targets.connector_id, connectorId))

  return db
    .select({ target: connector_targets, connector: connectors })
    .from(connector_targets)
    .innerJoin(connectors, eq(connector_targets.connector_id, connectors.id))
    .where(and(...conditions))
}

export async function getConnectorTargetsForConnector(connectorId: string) {
  return db
    .select()
    .from(connector_targets)
    .where(eq(connector_targets.connector_id, connectorId))
    .orderBy(desc(connector_targets.created_at))
}

export async function createConnectorTarget(data: {
  connector_id: string
  name: string
  display_name?: string | null
  description?: string | null
  ref_keys: Record<string, string>
  scope_key?: string | null
  metadata?: Record<string, unknown>
}) {
  const rows = await db
    .insert(connector_targets)
    .values({
      connector_id: data.connector_id,
      name: data.name,
      display_name: data.display_name ?? null,
      description: data.description ?? null,
      ref_keys: data.ref_keys,
      scope_key: data.scope_key ?? null,
      metadata: data.metadata ?? {},
    })
    .returning()
  return rows[0]!
}

export async function updateConnectorTarget(id: string, data: Partial<{
  name: string
  display_name: string | null
  description: string | null
  ref_keys: Record<string, string>
  scope_key: string | null
  metadata: Record<string, unknown>
}>) {
  const rows = await db
    .update(connector_targets)
    .set({ ...data, updated_at: new Date() })
    .where(eq(connector_targets.id, id))
    .returning()
  return rows[0] ?? null
}

export async function deleteConnectorTarget(id: string) {
  await db.delete(connector_targets).where(eq(connector_targets.id, id))
}
