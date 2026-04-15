import { getAuthHeaders } from './auth'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(init?.headers ?? {}),
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error?: string }).error ?? 'Request failed')
  }

  return res.json() as Promise<T>
}

export const api = {
  auth: {
    register: (body: { email: string; name: string; password: string }) =>
      request<{ token: string; user: { id: string; email: string; name: string } }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    login: (body: { email: string; password: string }) =>
      request<{ token: string; user: { id: string; email: string; name: string } }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  companies: {
    list: () => request<{ companies: Company[] }>('/api/companies'),
    create: (body: { name: string; slug?: string }) =>
      request<{ company: Company }>('/api/companies', { method: 'POST', body: JSON.stringify(body) }),
    update: (slug: string, body: { name?: string; slug?: string }) =>
      request<{ company: Company }>(`/api/companies/${slug}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (slug: string) =>
      request<{ ok: boolean }>(`/api/companies/${slug}`, { method: 'DELETE' }),
  },

  projects: {
    list: (companyId: string) => request<{ projects: Project[] }>(`/api/companies/${companyId}/projects`),
    create: (companyId: string, body: { name: string; slug?: string }) =>
      request<{ project: Project }>(`/api/companies/${companyId}/projects`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (projectId: string, body: { name?: string; slug?: string; default_timezone?: string }) =>
      request<{ project: Project }>(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (companyId: string, projectId: string) =>
      request<{ ok: boolean }>(`/api/companies/${companyId}/projects/${projectId}`, { method: 'DELETE' }),
    usage: (projectId: string, params?: { limit?: number; offset?: number; since?: string }) => {
      const qs = new URLSearchParams()
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      if (params?.since) qs.set('since', params.since)
      return request<{ logs: ProjectUsageLog[]; summary: UsageSummary; total: number }>(`/api/projects/${projectId}/usage?${qs}`)
    },
  },

  agents: {
    list: (projectId: string) => request<{ agents: Agent[] }>(`/api/projects/${projectId}/agents`),
    create: (projectId: string, body: Omit<Agent, 'id' | 'project_id' | 'created_at' | 'slug'> & { slug?: string }) =>
      request<{ agent: Agent }>(`/api/projects/${projectId}/agents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    get: (agentId: string) =>
      request<{ agent: Agent }>(`/api/agents/${agentId}`),
    update: (agentId: string, body: Partial<Agent>) =>
      request<{ agent: Agent }>(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (agentId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}`, { method: 'DELETE' }),
    usage: (agentId: string, params?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      return request<{ logs: UsageLog[]; summary: UsageSummary; total: number }>(`/api/agents/${agentId}/usage?${qs}`)
    },
    preview: (agentId: string, body: { mode?: 'chat' | 'task' }) =>
      request<PreviewRunResult>(`/api/agents/${agentId}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listAdapters: () =>
      request<{ adapters: AgentAdapterInfo[] }>(`/api/agents/adapters`),
  },

  policies: {
    // Company-level policy CRUD
    list: (companyId: string) => request<{ policies: Policy[] }>(`/api/companies/${companyId}/policies`),
    create: (companyId: string, body: { name: string; description?: string; is_template?: boolean }) =>
      request<{ policy: Policy }>(`/api/companies/${companyId}/policies`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    get: (policyId: string) => request<{ policy: Policy }>(`/api/policies/${policyId}`),
    update: (policyId: string, body: Partial<{ name: string; description: string; is_template: boolean }>) =>
      request<{ policy: Policy }>(`/api/policies/${policyId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (policyId: string) =>
      request<{ ok: boolean }>(`/api/policies/${policyId}`, { method: 'DELETE' }),

    // Policy rules (under a policy, not an agent)
    getRules: (policyId: string) => request<{ rules: PolicyRule[] }>(`/api/policies/${policyId}/rules`),
    createRule: (policyId: string, body: Omit<PolicyRule, 'id'>) =>
      request<{ rule: PolicyRule }>(`/api/policies/${policyId}/rules`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deleteRule: (policyId: string, ruleId: string) =>
      request<{ ok: boolean }>(`/api/policies/${policyId}/rules/${ruleId}`, { method: 'DELETE' }),

    // Agent ↔ Policy attach/detach
    getAgentPolicies: (agentId: string) =>
      request<{ policies: AgentPolicyItem[] }>(`/api/agents/${agentId}/policies`),
    attachPolicy: (agentId: string, body: { policy_id: string; project_id: string; priority?: number }) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/policies`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    detachPolicy: (agentId: string, policyId: string, projectId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/policies/${policyId}?project_id=${projectId}`, {
        method: 'DELETE',
      }),

    // User self-restriction policies
    getUsers: (agentId: string) => request<{ policies: UserPolicy[] }>(`/api/agents/${agentId}/policies/users`),
    getMyPolicy: (agentId: string) => request<{ policy: UserPolicy | null }>(`/api/agents/${agentId}/policies/users/me`),
    updateUserPolicy: (agentId: string, userId: string, body: { allowed_permissions: string[]; company_id: string }) =>
      request<{ policy: UserPolicy }>(`/api/agents/${agentId}/policies/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  conversations: {
    list: (agentId: string) => request<{ conversations: ConversationItem[] }>(`/api/agents/${agentId}/conversations`),
    listProject: (projectId: string) =>
      request<{ conversations: ConversationItemWithAgent[] }>(`/api/projects/${projectId}/conversations`),
    get: (convId: string) =>
      request<{ conversation: ConversationItemWithAgent }>(`/api/conversations/${convId}`),
    create: (agentId: string, body?: { mode?: string }) =>
      request<{ conversation: ConversationItem }>(`/api/agents/${agentId}/conversations`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    messages: (convId: string) =>
      request<{
        conversation_id?: string
        active_tip_message_id?: string | null
        messages: {
          id: string
          role: string
          parts: { type: string; [key: string]: unknown }[]
          created_at: string | null
          // Plan 23 — present when served via active-path query
          parent_message_id?: string | null
          branch_index?: number
          sibling_count?: number
          sibling_ids?: string[]
          current_sibling_index?: number
        }[]
      }>(`/api/conversations/${convId}/messages`),
    // Plan 23 — branch navigation
    resolveSiblingTip: (convId: string, siblingId: string) =>
      request<{ tip_message_id: string }>(
        `/api/conversations/${convId}/sibling-tip?sibling_id=${encodeURIComponent(siblingId)}`,
      ),
    setActiveTip: (convId: string, tipMessageId: string) =>
      request<{ ok: boolean; active_tip_message_id: string; messages: unknown[] }>(
        `/api/conversations/${convId}/active-tip`,
        { method: 'PATCH', body: JSON.stringify({ tip_message_id: tipMessageId }) },
      ),
    regenerate: (convId: string, userMessageId: string) =>
      fetch(`${BASE_URL}/api/conversations/${convId}/regenerate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ user_message_id: userMessageId }),
      }),
    preview: (convId: string, body: { mode?: 'chat' | 'task' }) =>
      request<PreviewRunResult>(`/api/conversations/${convId}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    status: (convId: string) =>
      request<{ running: boolean }>(`/api/conversations/${convId}/status`),
    liveParts: (convId: string) =>
      request<{ running: boolean; chunks: Record<string, unknown>[] }>(`/api/conversations/${convId}/live-parts`),
    rename: (convId: string, title: string) =>
      request<{ ok: boolean }>(`/api/conversations/${convId}/title`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    delete: (convId: string) =>
      request<{ ok: boolean }>(`/api/conversations/${convId}`, { method: 'DELETE' }),
  },

  plugins: {
    list: () => request<{ plugins: PluginItem[] }>('/api/plugins'),
    get: (id: string) => request<{ plugin: PluginItem }>(`/api/plugins/${id}`),
    configSchema: (id: string) => request<{ schema: Record<string, unknown> }>(`/api/plugins/${id}/config-schema`),
    listProject: (projectId: string) => request<{ plugins: PluginItem[] }>(`/api/projects/${projectId}/plugins`),
    listActive: (projectId: string) => request<{ plugins: ProjectPluginItem[] }>(`/api/projects/${projectId}/plugins/active`),
    enable: (projectId: string, pluginId: string, config?: Record<string, unknown>) =>
      request<{ plugin: ProjectPluginItem }>(`/api/projects/${projectId}/plugins/${pluginId}/enable`, {
        method: 'POST',
        body: JSON.stringify({ config: config ?? {} }),
      }),
    disable: (projectId: string, pluginId: string) =>
      request<{ plugin: ProjectPluginItem }>(`/api/projects/${projectId}/plugins/${pluginId}/disable`, {
        method: 'POST',
      }),
    updateConfig: (projectId: string, pluginId: string, config: Record<string, unknown>) =>
      request<{ plugin: ProjectPluginItem }>(`/api/projects/${projectId}/plugins/${pluginId}/config`, {
        method: 'PATCH',
        body: JSON.stringify(config),
      }),
  },

  memory: {
    list: (projectId: string, params?: { agent_id?: string; user_id?: string; scope?: string; tier?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.agent_id) qs.set('agent_id', params.agent_id)
      if (params?.user_id) qs.set('user_id', params.user_id)
      if (params?.scope) qs.set('scope', params.scope)
      if (params?.tier) qs.set('tier', params.tier)
      if (params?.limit != null) qs.set('limit', String(params.limit))
      if (params?.offset != null) qs.set('offset', String(params.offset))
      const q = qs.toString()
      return request<{ memories: MemoryItem[] }>(`/api/projects/${projectId}/memories${q ? `?${q}` : ''}`)
    },
    delete: (id: string) => request<{ success: boolean }>(`/api/memories/${id}`, { method: 'DELETE' }),
    update: (id: string, body: { content?: string; importance?: 'low' | 'medium' | 'high'; visibility?: 'private' | 'agent_shared' | 'project_shared' }) =>
      request<{ memory: MemoryItem }>(`/api/memories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  memoryConfig: {
    getProject: (projectId: string) =>
      request<{ config: ResolvedMemoryConfig }>(`/api/projects/${projectId}/memory-config`),
    updateProject: (projectId: string, config: Partial<ResolvedMemoryConfig>) =>
      request<{ config: ResolvedMemoryConfig }>(`/api/projects/${projectId}/memory-config`, {
        method: 'PATCH',
        body: JSON.stringify(config),
      }),
    getAgent: (agentId: string) =>
      request<{ config: AgentMemoryConfig | null }>(`/api/agents/${agentId}/memory-config`),
    updateAgent: (agentId: string, config: AgentMemoryConfig | null) =>
      request<{ config: AgentMemoryConfig | null }>(`/api/agents/${agentId}/memory-config`, {
        method: 'PATCH',
        body: JSON.stringify(config),
      }),
    getAgentResolved: (agentId: string) =>
      request<{ resolved: ResolvedMemoryConfig; project_config: ResolvedMemoryConfig; agent_config: AgentMemoryConfig | null }>(`/api/agents/${agentId}/memory-config/resolved`),
    // Plan 19
    triggerDream: (projectId: string, phase: 'light' | 'deep' | 'rem') =>
      request<{ ok: true; phase: string }>(`/api/projects/${projectId}/memory/dream`, {
        method: 'POST',
        body: JSON.stringify({ phase }),
      }),
    listJobs: (projectId: string, params?: { status?: string; type?: string }) => {
      const qs = new URLSearchParams()
      if (params?.status) qs.set('status', params.status)
      if (params?.type) qs.set('type', params.type)
      const q = qs.toString()
      return request<{ jobs: Array<{ id: string; type: string; status: string; attempts: number; scheduled_at: string; completed_at: string | null; error: string | null; created_at: string }> }>(`/api/projects/${projectId}/jobs${q ? `?${q}` : ''}`)
    },
  },

  persona: {
    getSeed: (agentId: string) =>
      request<{ seed: PersonaSeed | null; seeded_at: string | null }>(`/api/agents/${agentId}/persona/seed`),
    updateSeed: (agentId: string, seed: PersonaSeed | null) =>
      request<{ seed: PersonaSeed | null }>(`/api/agents/${agentId}/persona/seed`, {
        method: 'PATCH',
        body: JSON.stringify(seed),
      }),
    reset: (agentId: string) =>
      request<{ success: boolean }>(`/api/agents/${agentId}/persona/reset`, { method: 'POST' }),
    getMemories: (agentId: string) =>
      request<{ memories: MemoryItem[] }>(`/api/agents/${agentId}/persona/memories`),
    getPrompt: (agentId: string) =>
      request<{ prompt: string | null }>(`/api/agents/${agentId}/persona/prompt`),
    updatePrompt: (agentId: string, prompt: string | null) =>
      request<{ prompt: string | null }>(`/api/agents/${agentId}/persona/prompt`, {
        method: 'PATCH',
        body: JSON.stringify({ prompt }),
      }),
  },

  credentials: {
    // Adapters registry
    adapters: (group_id?: string) =>
      request<{ adapters: CredentialAdapter[] }>(`/api/credentials/adapters${group_id ? `?group_id=${group_id}` : ''}`),

    // Company credentials
    listCompany: (companySlug: string) =>
      request<{ credentials: CredentialItem[] }>(`/api/companies/${companySlug}/credentials`),
    createCompany: (companySlug: string, body: CreateCredentialBody) =>
      request<{ credential: CredentialItem }>(`/api/companies/${companySlug}/credentials`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    // Project credentials
    listProject: (projectId: string) =>
      request<{ credentials: CredentialItem[] }>(`/api/projects/${projectId}/credentials`),
    createProject: (projectId: string, body: CreateCredentialBody) =>
      request<{ credential: CredentialItem }>(`/api/projects/${projectId}/credentials`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    // Available for project (union company + project)
    available: (projectId: string, group_id?: string) =>
      request<{ credentials: CredentialItem[] }>(
        `/api/projects/${projectId}/credentials/available${group_id ? `?group_id=${group_id}` : ''}`
      ),

    // Shared by ID
    update: (credentialId: string, body: Partial<CreateCredentialBody>) =>
      request<{ credential: CredentialItem }>(`/api/credentials/${credentialId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (credentialId: string) =>
      request<{ ok: boolean }>(`/api/credentials/${credentialId}`, { method: 'DELETE' }),
    test: (credentialId: string) =>
      request<{ ok: boolean; message: string }>(`/api/credentials/${credentialId}/test`, { method: 'POST' }),

    // Agent credential assignment
    getAgent: (agentId: string) =>
      request<{ agent_credential: AgentCredentialItem | null }>(`/api/agents/${agentId}/credentials`),
    assignAgent: (agentId: string, body: { credential_id: string; model_id?: string; metadata_override?: Record<string, string> }) =>
      request<{ agent_credential: AgentCredentialItem }>(`/api/agents/${agentId}/credentials`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateAgent: (agentId: string, body: { model_id?: string; metadata_override?: Record<string, string>; credential_id?: string }) =>
      request<{ agent_credential: AgentCredentialItem }>(`/api/agents/${agentId}/credentials`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    unassignAgent: (agentId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/credentials`, { method: 'DELETE' }),
  },

  connectorSetup: {
    start: (projectId: string, credentialId: string) =>
      request<ConnectorSetupStartResponse>(
        `/api/projects/${projectId}/credentials/${credentialId}/setup/start`,
        { method: 'POST' }
      ),
    step: (
      projectId: string,
      credentialId: string,
      sessionId: string,
      body: { step_id: string; input: Record<string, ConnectorSetupStepInputValue> }
    ) =>
      request<ConnectorSetupStepResult>(
        `/api/projects/${projectId}/credentials/${credentialId}/setup/${sessionId}/step`,
        { method: 'POST', body: JSON.stringify(body) }
      ),
    cancel: (projectId: string, credentialId: string, sessionId: string) =>
      request<{ ok: boolean }>(
        `/api/projects/${projectId}/credentials/${credentialId}/setup/${sessionId}`,
        { method: 'DELETE' }
      ),
  },

  runs: {
    list: (projectId: string, params?: {
      type?: string
      agent_id?: string
      run_status?: string
      page?: number
      per_page?: number
      sort?: 'created_at' | 'started_at' | 'finished_at'
      order?: 'asc' | 'desc'
    }) => {
      const qs = new URLSearchParams()
      if (params?.type) qs.set('type', params.type)
      if (params?.agent_id) qs.set('agent_id', params.agent_id)
      if (params?.run_status) qs.set('run_status', params.run_status)
      if (params?.page) qs.set('page', String(params.page))
      if (params?.per_page) qs.set('per_page', String(params.per_page))
      if (params?.sort) qs.set('sort', params.sort)
      if (params?.order) qs.set('order', params.order)
      const q = qs.toString()
      return request<RunsListResult>(`/api/projects/${projectId}/runs${q ? `?${q}` : ''}`)
    },
    cancel: (convId: string) =>
      request<{ ok: boolean }>(`/api/conversations/${convId}/cancel`, { method: 'POST' }),
  },

  heartbeat: {
    get: (agentId: string) =>
      request<HeartbeatConfig>(`/api/agents/${agentId}/heartbeat`),
    update: (agentId: string, body: Partial<HeartbeatConfig>) =>
      request<HeartbeatConfig>(`/api/agents/${agentId}/heartbeat`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    trigger: (agentId: string) =>
      request<{ ok: boolean; conversation_id: string }>(`/api/agents/${agentId}/heartbeat/trigger`, { method: 'POST' }),
  },

  connectors: {
    plugins: () => request<{ plugins: ConnectorPlugin[] }>('/api/connector-plugins'),
    list: (projectId: string) => request<{ connectors: ConnectorItem[] }>(`/api/projects/${projectId}/connectors`),
    create: (projectId: string, body: { plugin_id: string; display_name: string; credential_id?: string | null; config?: Record<string, unknown> }) =>
      request<{ connector: ConnectorItem }>(`/api/projects/${projectId}/connectors`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    get: (id: string) => request<{ connector: ConnectorItem }>(`/api/connectors/${id}`),
    update: (id: string, body: Partial<{ display_name: string; credential_id: string | null; config: Record<string, unknown>; status: string }>) =>
      request<{ connector: ConnectorItem }>(`/api/connectors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (id: string) => request<{ ok: boolean }>(`/api/connectors/${id}`, { method: 'DELETE' }),
    activate: (id: string) => request<{ ok: boolean; connector: ConnectorItem }>(`/api/connectors/${id}/activate`, { method: 'POST' }),
    deactivate: (id: string) => request<{ ok: boolean; connector: ConnectorItem }>(`/api/connectors/${id}/deactivate`, { method: 'POST' }),
    restart: (id: string) => request<{ ok: boolean; connector: ConnectorItem }>(`/api/connectors/${id}/restart`, { method: 'POST' }),
    health: (id: string) => request<{
      ok: boolean
      status: string
      error_message: string | null
      adapter: { polling: boolean; last_event_at: string | null; bot_user_id: number | null } | null
    }>(`/api/connectors/${id}/health`),
    getIdentity: (id: string) =>
      request<{
        ok: boolean
        identity: { name: string; username?: string | null; user_id?: string | null; metadata?: Record<string, unknown> } | null
        credential: { id: string; name: string; adapter_id: string } | null
        reason?: string
      }>(`/api/connectors/${id}/identity`),

    bindings: {
      list: (connectorId: string) => request<{ bindings: ConnectorBinding[] }>(`/api/connectors/${connectorId}/bindings`),
      create: (connectorId: string, body: Partial<ConnectorBinding>) =>
        request<{ binding: ConnectorBinding }>(`/api/connectors/${connectorId}/bindings`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      update: (connectorId: string, bindingId: string, body: Partial<ConnectorBinding>) =>
        request<{ binding: ConnectorBinding }>(`/api/connectors/${connectorId}/bindings/${bindingId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      delete: (connectorId: string, bindingId: string) =>
        request<{ ok: boolean }>(`/api/connectors/${connectorId}/bindings/${bindingId}`, { method: 'DELETE' }),
    },

    identities: {
      list: (connectorId: string, bindingId: string) =>
        request<{ identities: ConnectorIdentity[] }>(`/api/connectors/${connectorId}/bindings/${bindingId}/identities`),
      update: (connectorId: string, bindingId: string, identityId: string, body: { status?: string; mapped_user_id?: string }) =>
        request<{ identity: ConnectorIdentity }>(`/api/connectors/${connectorId}/bindings/${bindingId}/identities/${identityId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
    },

    pairingRequests: {
      list: (connectorId: string) =>
        request<{ pairing_requests: ConnectorIdentity[] }>(`/api/connectors/${connectorId}/pairing-requests`),
      approve: (connectorId: string, identityId: string, body: { output_adapter?: string; output_config: Record<string, unknown>; display_name?: string }) =>
        request<{ identity: ConnectorIdentity; binding: ConnectorBinding }>(`/api/connectors/${connectorId}/pairing-requests/${identityId}/approve`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      reject: (connectorId: string, identityId: string) =>
        request<{ identity: ConnectorIdentity }>(`/api/connectors/${connectorId}/pairing-requests/${identityId}/reject`, { method: 'POST' }),
    },

    // Debug panel — all identities ever seen by this connector (any status).
    listAllIdentities: (connectorId: string) =>
      request<{ identities: Array<{ id: string; connector_id: string; binding_id: string | null; external_ref_keys: Record<string, string> | null; display_name: string | null; status: 'pending' | 'approved' | 'blocked'; created_at: string; approved_at: string | null; last_seen_at: string | null }> }>(`/api/connectors/${connectorId}/identities`),
    resetIdentity: (connectorId: string, identityId: string) =>
      request<{ ok: boolean; identity: unknown }>(`/api/connectors/${connectorId}/identities/${identityId}/reset`, { method: 'POST' }),
    forceDeleteIdentity: (connectorId: string, identityId: string) =>
      request<{ ok: boolean }>(`/api/connectors/${connectorId}/identities/${identityId}`, { method: 'DELETE' }),

    // Blocked identities — rejected DM pairings or stuck rows. Admin can unblock
    // (send back to pending queue) or hard-delete.
    blockedIdentities: {
      list: (connectorId: string) =>
        request<{ identities: ConnectorIdentity[] }>(`/api/connectors/${connectorId}/blocked-identities`),
      unblock: (connectorId: string, identityId: string) =>
        request<{ identity: ConnectorIdentity }>(`/api/connectors/${connectorId}/blocked-identities/${identityId}/unblock`, { method: 'POST' }),
      delete: (connectorId: string, identityId: string) =>
        request<{ ok: boolean }>(`/api/connectors/${connectorId}/identities/${identityId}`, { method: 'DELETE' }),
    },

    // Group pairing drafts — bot was added to a group; admin must assign an agent.
    groupPairings: {
      list: (connectorId: string) =>
        request<{ group_pairings: ConnectorBinding[] }>(`/api/connectors/${connectorId}/group-pairings`),
      approve: (connectorId: string, bindingId: string, body: { agent_id: string; member_mode?: 'require_approval' | 'allow_all'; display_name?: string }) =>
        request<{ binding: ConnectorBinding }>(`/api/connectors/${connectorId}/group-pairings/${bindingId}/approve`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      reject: (connectorId: string, bindingId: string) =>
        request<{ ok: boolean }>(`/api/connectors/${connectorId}/group-pairings/${bindingId}/reject`, { method: 'POST' }),
    },

    targets: {
      list: (connectorId: string) =>
        request<{ targets: ConnectorTargetItem[] }>(`/api/connectors/${connectorId}/targets`),
      create: (connectorId: string, body: {
        name: string; display_name?: string; description?: string
        ref_keys: Record<string, string>; scope_key?: string; metadata?: Record<string, unknown>
      }) =>
        request<{ target: ConnectorTargetItem }>(`/api/connectors/${connectorId}/targets`, {
          method: 'POST', body: JSON.stringify(body),
        }),
      update: (connectorId: string, targetId: string, body: Record<string, unknown>) =>
        request<{ target: ConnectorTargetItem }>(`/api/connectors/${connectorId}/targets/${targetId}`, {
          method: 'PATCH', body: JSON.stringify(body),
        }),
      delete: (connectorId: string, targetId: string) =>
        request<{ ok: boolean }>(`/api/connectors/${connectorId}/targets/${targetId}`, { method: 'DELETE' }),
    },

    scopes: {
      list: (connectorId: string, limit?: number) =>
        request<{ scopes: ConnectorScopeItem[] }>(`/api/connectors/${connectorId}/scopes${limit ? `?limit=${limit}` : ''}`),
    },

    inviteCodes: {
      list: (connectorId: string) =>
        request<{ invite_codes: ConnectorInviteCode[] }>(`/api/connectors/${connectorId}/invite-codes`),
      create: (connectorId: string, body: { label?: string; max_uses?: number; expires_at?: string }) =>
        request<{ invite_code: ConnectorInviteCode }>(`/api/connectors/${connectorId}/invite-codes`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      revoke: (connectorId: string, codeId: string) =>
        request<{ invite_code: ConnectorInviteCode }>(`/api/connectors/${connectorId}/invite-codes/${codeId}/revoke`, { method: 'POST' }),
      delete: (connectorId: string, codeId: string) =>
        request<{ ok: boolean }>(`/api/connectors/${connectorId}/invite-codes/${codeId}`, { method: 'DELETE' }),
    },

    // ─── Project-level paginated lists with filters ──────────────────────────
    listProjectEvents: (projectId: string, filters: ConnectorEventFilters = {}) => {
      const qs = buildConnectorListQuery(filters)
      return request<{ events: ConnectorEventListItem[]; next_cursor: string | null }>(
        `/api/projects/${projectId}/connector-events${qs}`,
      )
    },

    listProjectMessages: (projectId: string, filters: ConnectorMessageFilters = {}) => {
      const qs = buildConnectorListQuery(filters)
      return request<{ messages: ConnectorMessageListItem[]; next_cursor: string | null }>(
        `/api/projects/${projectId}/connector-messages${qs}`,
      )
    },

    // ─── SSE stream URL builders (for use with EventSource) ──────────────────
    projectEventsStreamUrl: (projectId: string, filters: ConnectorEventFilters = {}) => {
      const headers = getAuthHeaders() as Record<string, string>
      const token = headers['Authorization']?.replace('Bearer ', '') ?? ''
      const params = new URLSearchParams()
      if (token) params.set('token', token)
      if (filters.connector_id) params.set('connector_id', filters.connector_id)
      if (filters.event_type) params.set('event_type', filters.event_type)
      if (filters.direction) params.set('direction', filters.direction)
      if (filters.status) params.set('status', filters.status)
      return `${BASE_URL}/api/projects/${projectId}/connector-events/stream?${params.toString()}`
    },

    projectMessagesStreamUrl: (projectId: string, filters: ConnectorMessageFilters = {}) => {
      const headers = getAuthHeaders() as Record<string, string>
      const token = headers['Authorization']?.replace('Bearer ', '') ?? ''
      const params = new URLSearchParams()
      if (token) params.set('token', token)
      if (filters.connector_id) params.set('connector_id', filters.connector_id)
      if (filters.direction) params.set('direction', filters.direction)
      if (filters.status) params.set('status', filters.status)
      return `${BASE_URL}/api/projects/${projectId}/connector-messages/stream?${params.toString()}`
    },
  },

  filesystem: {
    getConfig: (projectId: string) =>
      request<{ config: FilesystemConfig | null }>(`/api/projects/${projectId}/filesystem/config`),
    updateConfig: (projectId: string, body: { adapter_id?: string; credential_id?: string | null; enabled?: boolean }) =>
      request<{
        config: FilesystemConfig
        migration_needed: boolean
        file_count?: number
        total_size_bytes?: number
        pending_adapter_id?: string
        pending_credential_id?: string
      }>(`/api/projects/${projectId}/filesystem/config`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    migrate: (projectId: string, body: { credential_id: string; adapter_id: string; action: 'migrate' | 'reset' }) =>
      request<{ ok: boolean; config: FilesystemConfig; migrated: number; failed: number; errors: string[]; deleted?: number }>(
        `/api/projects/${projectId}/filesystem/migrate`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    testConnection: (projectId: string) =>
      request<{ ok: boolean; message: string }>(`/api/projects/${projectId}/filesystem/test`, { method: 'POST' }),

    list: (projectId: string, folderPath = '/') =>
      request<{ entries: FilesystemEntry[]; count: number }>(
        `/api/projects/${projectId}/files?path=${encodeURIComponent(folderPath)}`
      ),
    content: (projectId: string, filePath: string) =>
      request<{ path: string; content: string }>(
        `/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`
      ),
    write: (projectId: string, body: { path: string; content: string }) =>
      request<{ file: FilesystemFileEntry }>(`/api/projects/${projectId}/files`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createFolder: (projectId: string, folderPath: string) =>
      request<{ ok: boolean; path: string }>(`/api/projects/${projectId}/files/folder`, {
        method: 'POST',
        body: JSON.stringify({ path: folderPath }),
      }),
    move: (projectId: string, body: { from: string; to: string }) =>
      request<{ ok: boolean; from: string; to: string }>(`/api/projects/${projectId}/files/move`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (projectId: string, filePath: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' }),
    deleteFolder: (projectId: string, folderPath: string) =>
      request<{ ok: boolean; deleted: number }>(`/api/projects/${projectId}/files/folder?path=${encodeURIComponent(folderPath)}`, { method: 'DELETE' }),
    search: (projectId: string, query: string, ext?: string) => {
      const qs = new URLSearchParams({ q: query })
      if (ext) qs.set('ext', ext)
      return request<{ files: FilesystemFileEntry[]; count: number }>(`/api/projects/${projectId}/files/search?${qs}`)
    },
    proxyUrl: (projectId: string, filePath: string, mode: 'inline' | 'download' | 'preview' = 'inline') => {
      const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
      const qs = new URLSearchParams({ path: filePath, mode })
      return `${BASE_URL}/api/projects/${projectId}/files/proxy?${qs}`
    },
    getPermission: (projectId: string, path: string) =>
      request<{ effective: 'read+write' | 'read'; source: 'default' | 'self' | 'inherited'; source_path: string | null }>(
        `/api/projects/${projectId}/files/permission?path=${encodeURIComponent(path)}`
      ),
    setPermission: (
      projectId: string,
      body: { path: string; type: 'file' | 'folder'; permission: 'read' | 'read+write' | null },
    ) =>
      request<{ ok: boolean; resolved: { effective: 'read+write' | 'read'; source: 'default' | 'self' | 'inherited'; source_path: string | null } }>(
        `/api/projects/${projectId}/files/permission`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    upload: async (projectId: string, folderPath: string, files: File[]) => {
      const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
      const form = new FormData()
      for (const f of files) form.append('file', f)
      const qs = new URLSearchParams({ path: folderPath })
      const r = await fetch(`${BASE_URL}/api/projects/${projectId}/files/upload?${qs}`, {
        method: 'POST',
        headers: { ...getAuthHeaders() },
        body: form,
      })
      const body = await r.json() as { files?: FilesystemFileEntry[]; error?: string }
      if (!r.ok) throw new Error(body.error ?? 'Upload failed')
      return body as { files: FilesystemFileEntry[] }
    },
  },

  browser: {
    // Legacy (deprecated) — operate on the default profile.
    get: (projectId: string) =>
      request<{ enabled: boolean; config: BrowserProjectConfig; profiles: BrowserProfile[] }>(`/api/projects/${projectId}/browser`),
    setEnabled: (projectId: string, enabled: boolean) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/browser/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    updateConfig: (projectId: string, config: BrowserProjectConfig) =>
      request<{ ok: boolean; config: BrowserProjectConfig }>(`/api/projects/${projectId}/browser/config`, {
        method: 'PATCH',
        body: JSON.stringify(config),
      }),
    ping: (projectId: string) =>
      request<BrowserPingResult>(`/api/projects/${projectId}/browser/ping`, {
        method: 'POST',
      }),
    preview: (projectId: string) =>
      request<BrowserPreviewResult>(`/api/projects/${projectId}/browser/preview`, {
        method: 'POST',
      }),
    status: (projectId: string) =>
      request<BrowserStatus>(`/api/projects/${projectId}/browser/status`),

    // Plan 20 — profile-aware endpoints.
    listAdapters: (projectId: string) =>
      request<{ adapters: BrowserAdapterInfo[] }>(`/api/projects/${projectId}/browser/adapters`),
    listProfiles: (projectId: string) =>
      request<{ profiles: BrowserProfile[] }>(`/api/projects/${projectId}/browser/profiles`),
    createProfile: (projectId: string, data: BrowserProfileCreate) =>
      request<{ profile: BrowserProfile }>(`/api/projects/${projectId}/browser/profiles`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getProfile: (projectId: string, profileId: string) =>
      request<{ profile: BrowserProfile }>(`/api/projects/${projectId}/browser/profiles/${profileId}`),
    updateProfile: (projectId: string, profileId: string, data: BrowserProfilePatch) =>
      request<{ profile: BrowserProfile }>(`/api/projects/${projectId}/browser/profiles/${profileId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    deleteProfile: (projectId: string, profileId: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/browser/profiles/${profileId}`, {
        method: 'DELETE',
      }),
    setDefaultProfile: (projectId: string, profileId: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/browser/profiles/${profileId}/default`, {
        method: 'POST',
      }),
    pingProfile: (projectId: string, profileId: string) =>
      request<BrowserPingResult>(`/api/projects/${projectId}/browser/profiles/${profileId}/ping`, {
        method: 'POST',
      }),
    previewProfile: (projectId: string, profileId: string) =>
      request<BrowserPreviewResult>(`/api/projects/${projectId}/browser/profiles/${profileId}/preview`, {
        method: 'POST',
      }),
    statusProfile: (projectId: string, profileId: string) =>
      request<BrowserStatus>(`/api/projects/${projectId}/browser/profiles/${profileId}/status`),
  },

  attachments: {
    list: (projectId: string, opts?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (opts?.limit) qs.set('limit', String(opts.limit))
      if (opts?.offset) qs.set('offset', String(opts.offset))
      return request<{ attachments: ProjectAttachment[] }>(`/api/projects/${projectId}/attachments?${qs}`)
    },
    upload: (projectId: string, files: File[], opts?: { agent_id?: string; conversation_id?: string }) => {
      const qs = new URLSearchParams()
      if (opts?.agent_id) qs.set('agent_id', opts.agent_id)
      if (opts?.conversation_id) qs.set('conversation_id', opts.conversation_id)
      const form = new FormData()
      files.forEach(f => form.append('file', f))
      return fetch(`${BASE_URL}/api/projects/${projectId}/attachments/upload?${qs}`, {
        method: 'POST',
        headers: { ...getAuthHeaders() },
        body: form,
      }).then(r => r.json() as Promise<{ attachments: Array<{ attachment_id: string; storage_key: string; filename: string; mime_type: string; size_bytes: number }> }>)
    },
    delete: (projectId: string, id: string) =>
      request<{ success: boolean }>(`/api/projects/${projectId}/attachments/${id}`, { method: 'DELETE' }),
  },

  acl: {
    // Project roles
    listRoles: (projectId: string) =>
      request<{ roles: ProjectRole[] }>(`/api/projects/${projectId}/roles`),
    createRole: (projectId: string, body: { name: string; description?: string; permissions?: string[]; is_default?: boolean }) =>
      request<{ role: ProjectRole }>(`/api/projects/${projectId}/roles`, { method: 'POST', body: JSON.stringify(body) }),
    updateRole: (projectId: string, roleId: string, body: { name?: string; description?: string; permissions?: string[]; is_default?: boolean }) =>
      request<{ role: ProjectRole }>(`/api/projects/${projectId}/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteRole: (projectId: string, roleId: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/roles/${roleId}`, { method: 'DELETE' }),
    getRolePresets: (projectId: string) =>
      request<{ presets: Record<string, { name: string; permissions: string[] }> }>(`/api/projects/${projectId}/roles/presets`),

    // Project members
    listMembers: (projectId: string) =>
      request<{ members: ProjectMember[] }>(`/api/projects/${projectId}/members`),
    getMyPermissions: (projectId: string) =>
      request<ResolvedProjectPermissions>(`/api/projects/${projectId}/members/me/permissions`),
    assignRole: (projectId: string, userId: string, roleId: string | null) =>
      request<{ membership: ProjectMembership }>(`/api/projects/${projectId}/members/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role_id: roleId }) }),
    setSuperadmin: (projectId: string, userId: string, grant: boolean) =>
      request<{ membership: ProjectMembership }>(`/api/projects/${projectId}/members/${userId}/superadmin`, { method: 'PATCH', body: JSON.stringify({ grant }) }),
    setAgentRestrictions: (projectId: string, userId: string, agent_restrictions: Record<string, boolean>) =>
      request<{ membership: ProjectMembership }>(`/api/projects/${projectId}/members/${userId}/agent-restrictions`, { method: 'PATCH', body: JSON.stringify({ agent_restrictions }) }),
    removeMember: (projectId: string, userId: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

    // Invitations (user side)
    listMyInvitations: () =>
      request<{ invitations: InvitationItem[] }>('/api/auth/invitations'),
    acceptInvitation: (id: string) =>
      request<{ ok: boolean }>(`/api/auth/invitations/${id}/accept`, { method: 'POST' }),
    declineInvitation: (id: string) =>
      request<{ ok: boolean }>(`/api/auth/invitations/${id}/decline`, { method: 'POST' }),

    // Company members (admin side)
    listCompanyMembers: (companyId: string) =>
      request<{ members: CompanyMemberItem[] }>(`/api/companies/${companyId}/members`),
    removeCompanyMember: (companyId: string, userId: string) =>
      request<{ ok: boolean }>(`/api/companies/${companyId}/members/${userId}`, { method: 'DELETE' }),
    listMemberProjects: (companyId: string, userId: string) =>
      request<{ memberships: MemberProjectItem[] }>(`/api/companies/${companyId}/members/${userId}/projects`),
    grantMemberProject: (companyId: string, userId: string, body: { project_id: string; role_id?: string }) =>
      request<{ membership: ProjectMembership }>(`/api/companies/${companyId}/members/${userId}/projects`, { method: 'POST', body: JSON.stringify(body) }),
    revokeMemberProject: (companyId: string, userId: string, projectId: string) =>
      request<{ ok: boolean }>(`/api/companies/${companyId}/members/${userId}/projects/${projectId}`, { method: 'DELETE' }),

    // Invitations (admin side)
    listCompanyInvitations: (companyId: string) =>
      request<{ invitations: InvitationItem[] }>(`/api/companies/${companyId}/invitations`),
    sendInvitation: (companyId: string, body: { email: string; project_grants: Array<{ project_id: string; role_id: string }> }) =>
      request<{ invitation: InvitationItem }>(`/api/companies/${companyId}/invitations`, { method: 'POST', body: JSON.stringify(body) }),
    cancelInvitation: (companyId: string, invitationId: string) =>
      request<{ ok: boolean }>(`/api/companies/${companyId}/invitations/${invitationId}`, { method: 'DELETE' }),
  },

  cronTasks: {
    list: (projectId: string, opts?: { status?: 'active' | 'archived' | 'all' }) => {
      const qs = opts?.status === 'archived'
        ? '?status=archived'
        : opts?.status === 'all'
          ? '?include_archived=1'
          : ''
      return request<{ cron_tasks: CronTask[] }>(`/api/projects/${projectId}/cron-tasks${qs}`)
    },
    create: (projectId: string, body: {
      agent_id: string
      name: string
      description?: string
      mode?: CronTaskMode
      cron_expression?: string | null
      run_at?: string | null
      prompt: string
      enabled?: boolean
    }) =>
      request<{ cron_task: CronTask }>(`/api/projects/${projectId}/cron-tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    get: (projectId: string, id: string) =>
      request<{ cron_task: CronTask }>(`/api/projects/${projectId}/cron-tasks/${id}`),
    update: (projectId: string, id: string, body: Partial<{
      name: string
      description: string | null
      mode: CronTaskMode
      cron_expression: string | null
      run_at: string | null
      prompt: string
      enabled: boolean
      agent_id: string
    }>) =>
      request<{ cron_task: CronTask }>(`/api/projects/${projectId}/cron-tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (projectId: string, id: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/cron-tasks/${id}`, { method: 'DELETE' }),
    archive: (projectId: string, id: string) =>
      request<{ cron_task: CronTask }>(`/api/projects/${projectId}/cron-tasks/${id}/archive`, { method: 'POST' }),
    restore: (projectId: string, id: string) =>
      request<{ cron_task: CronTask }>(`/api/projects/${projectId}/cron-tasks/${id}/restore`, { method: 'POST' }),
    trigger: (projectId: string, id: string) =>
      request<{ ok: boolean; conversation_id: string }>(`/api/projects/${projectId}/cron-tasks/${id}/trigger`, { method: 'POST' }),
  },

  skills: {
    // Project skills (files are stored on the filesystem under /skills/{slug}/)
    list: (projectId: string) =>
      request<{ skills: SkillItem[] }>(`/api/projects/${projectId}/skills`),
    create: (projectId: string, body: { name: string; slug?: string; description?: string; tags?: string[]; entrypoint?: string }) =>
      request<{ skill: SkillItem }>(`/api/projects/${projectId}/skills`, { method: 'POST', body: JSON.stringify(body) }),
    get: (skillId: string) =>
      request<{ skill: SkillItem }>(`/api/skills/${skillId}`),
    update: (skillId: string, body: Partial<{ name: string; description: string; tags: string[]; entrypoint: string; enabled: boolean }>) =>
      request<{ skill: SkillItem }>(`/api/skills/${skillId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (skillId: string) =>
      request<{ ok: boolean }>(`/api/skills/${skillId}`, { method: 'DELETE' }),

    // Agent skill assignments
    listAgentSkills: (agentId: string) =>
      request<{ assignments: AgentSkillAssignment[] }>(`/api/agents/${agentId}/skills`),
    assignSkill: (agentId: string, body: { skill_id: string; mode?: 'always' | 'on_demand' }) =>
      request<{ assignment: AgentSkillAssignment }>(`/api/agents/${agentId}/skills`, { method: 'POST', body: JSON.stringify(body) }),
    updateAssignment: (agentId: string, skillId: string, mode: 'always' | 'on_demand') =>
      request<{ assignment: AgentSkillAssignment }>(`/api/agents/${agentId}/skills/${skillId}`, { method: 'PATCH', body: JSON.stringify({ mode }) }),
    removeSkill: (agentId: string, skillId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' }),

    // Plan 19
    refresh: (projectId: string) =>
      request<{ ok: true; count: number }>(`/api/projects/${projectId}/skills/refresh`, { method: 'POST' }),
    importFromGithub: (projectId: string, body: { package: string; overwrite?: boolean }) =>
      request<{ result: { slug: string; name: string; files_count: number; source_package: string } }>(
        `/api/projects/${projectId}/skills/import`,
        { method: 'POST', body: JSON.stringify({ source: 'github', ...body }) },
      ),
    importFromZip: async (projectId: string, file: File, overwrite = false) => {
      const url = `/api/projects/${projectId}/skills/import-zip${overwrite ? '?overwrite=true' : ''}`
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `ZIP import failed (${res.status})`)
      }
      return (await res.json()) as { result: { slug: string; name: string; files_count: number; source_package: string } }
    },
    setAgentAccessMode: (agentId: string, mode: 'manual' | 'all_on_demand') =>
      request<{ ok: true; mode: string }>(`/api/agents/${agentId}/skill-access-mode`, {
        method: 'PATCH',
        body: JSON.stringify({ mode }),
      }),
  },

  commands: {
    // Project commands (files are stored on the filesystem under /commands/{slug}/)
    list: (projectId: string) =>
      request<{ commands: CommandItem[] }>(`/api/projects/${projectId}/commands`),
    create: (projectId: string, body: { name: string; slug?: string; description?: string }) =>
      request<{ command: CommandItem }>(`/api/projects/${projectId}/commands`, { method: 'POST', body: JSON.stringify(body) }),
    get: (commandId: string) =>
      request<{ command: CommandItem }>(`/api/commands/${commandId}`),
    delete: (commandId: string) =>
      request<{ ok: boolean }>(`/api/commands/${commandId}`, { method: 'DELETE' }),
    refresh: (projectId: string) =>
      request<{ ok: true; count: number }>(`/api/projects/${projectId}/commands/refresh`, { method: 'POST' }),

    // Agent command assignments
    listAgentCommands: (agentId: string) =>
      request<{ assignments: AgentCommandAssignment[] }>(`/api/agents/${agentId}/commands`),
    assignCommand: (agentId: string, body: { command_id: string; pinned?: boolean }) =>
      request<{ assignment: AgentCommandAssignment }>(`/api/agents/${agentId}/commands`, { method: 'POST', body: JSON.stringify(body) }),
    removeCommand: (agentId: string, commandId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/commands/${commandId}`, { method: 'DELETE' }),
    setCommandAccessMode: (agentId: string, mode: 'manual' | 'all') =>
      request<{ ok: true; mode: string }>(`/api/agents/${agentId}/command-access-mode`, {
        method: 'PATCH',
        body: JSON.stringify({ mode }),
      }),
  },

  mcpServers: {
    list: (projectId: string) =>
      request<{ servers: McpServerItem[] }>(`/api/projects/${projectId}/mcp-servers`),
    create: (projectId: string, body: { name: string; transport: string; config: Record<string, unknown>; agent_id?: string; enabled?: boolean }) =>
      request<{ server: McpServerItem }>(`/api/projects/${projectId}/mcp-servers`, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<{ name: string; transport: string; config: Record<string, unknown>; enabled: boolean; agent_id: string | null }>) =>
      request<{ server: McpServerItem }>(`/api/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/mcp-servers/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      request<{ success: boolean; tool_count?: number; error?: string; tools?: Array<{ id: string; name: string }> }>(`/api/mcp-servers/${id}/test`, { method: 'POST' }),
  },

  toolStates: {
    get: (agentId: string) =>
      request<{ states: { project: Record<string, boolean>; agent: Record<string, boolean> } }>(`/api/agents/${agentId}/tools/states`),
    set: (agentId: string, toolId: string, enabled: boolean) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/tools/${encodeURIComponent(toolId)}/state`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    reset: (agentId: string, toolId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}/tools/${encodeURIComponent(toolId)}/state`, { method: 'DELETE' }),
  },

  auditLogs: {
    list: (projectId: string, params: {
      page?: number
      per_page?: number
      event_type?: string
      actor_id?: string
      resource_type?: string
      from?: string
      to?: string
    } = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
      return request<{ logs: AuditLogEntry[]; total: number; page: number; per_page: number }>(
        `/api/projects/${projectId}/audit-logs?${qs.toString()}`,
      )
    },
    get: (projectId: string, id: string) =>
      request<{ log: AuditLogEntry }>(`/api/projects/${projectId}/audit-logs/${id}`),
    exportUrl: (projectId: string, params: Record<string, string | undefined> = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v)
      return `${BASE_URL}/api/projects/${projectId}/audit-logs/export?${qs.toString()}`
    },
  },

  pluginPermissions: {
    listProject: (projectId: string) =>
      request<{ grants: PluginPermissionGrant[] }>(`/api/projects/${projectId}/plugin-permissions`),
    listMember: (projectId: string, userId: string) =>
      request<{ grants: PluginPermissionGrant[] }>(`/api/projects/${projectId}/members/${userId}/plugin-permissions`),
    replaceMember: (projectId: string, userId: string, grants: Array<{ plugin_id: string; permission: string }>) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/members/${userId}/plugin-permissions`, {
        method: 'PUT',
        body: JSON.stringify({ grants }),
      }),
    grant: (projectId: string, body: { user_id: string; plugin_id: string; permission: string }) =>
      request<{ grant: PluginPermissionGrant }>(`/api/projects/${projectId}/plugin-permissions/grant`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revoke: (projectId: string, id: string) =>
      request<{ ok: boolean }>(`/api/projects/${projectId}/plugin-permissions/${id}`, { method: 'DELETE' }),
  },
}

export interface AuditLogEntry {
  id: string
  project_id: string | null
  company_id: string | null
  actor_id: string | null
  actor_type: string
  event_type: string
  resource_type: string
  resource_id: string | null
  resource_name: string | null
  metadata: Record<string, unknown>
  ip_address: string | null
  user_agent: string | null
  created_at: string
  actor: { id: string; name: string; email: string } | null
}

export interface PluginPermissionGrant {
  id: string
  project_id: string
  membership_id: string
  plugin_id: string
  permission: string
  granted_by: string | null
  created_at: string
  user?: { id: string; name: string; email: string } | null
}

// Types

export interface FilesystemConfig {
  id: string
  project_id: string
  adapter_id: string
  credential_id: string | null
  enabled: boolean
  total_files: number
  total_size_bytes: number
  created_at: string
  updated_at: string
}

export interface FilesystemFolderEntry {
  type: 'folder'
  path: string
  name: string
  tool_permission?: 'read' | 'read+write' | null
}

export interface FilesystemFileEntry {
  type: 'file'
  id: string
  project_id: string
  path: string
  name: string
  folder_path: string
  extension: string
  storage_key: string
  size_bytes: number
  mime_type: string
  content_cache: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
  tool_permission?: 'read' | 'read+write' | null
}

export type FilesystemEntry = FilesystemFolderEntry | FilesystemFileEntry

/**
 * Browser config — CDP-only since Plan 33 (`@jiku/browser` migration).
 * Mirrors `BrowserProjectConfig` in `apps/studio/db/src/queries/browser.ts`.
 */
export interface BrowserProjectConfig {
  /** CDP endpoint, e.g. "ws://localhost:9222" or "http://localhost:9222". */
  cdp_url?: string
  /** Default per-command timeout in milliseconds (default: 30000). */
  timeout_ms?: number
  /** Allow agents to call `eval` (run arbitrary JS in the page). */
  evaluate_enabled?: boolean
  /** If true (default), screenshots persist as attachments instead of inline base64. */
  screenshot_as_attachment?: boolean
  /**
   * Hard cap on chromium tabs per project (including the system tab).
   * Default: 10. Bounds: 2..50.
   */
  max_tabs?: number
}

export interface BrowserPingResult {
  ok: boolean
  error?: string
  latency_ms?: number
  cdp_url?: string
  browser?: string
}

export interface BrowserPreviewResult {
  ok: boolean
  data?: {
    base64: string
    format: 'png' | 'jpeg'
    title: string | null
    url: string | null
  }
  error?: string
  hint?: string | null
}

export interface BrowserStatusTab {
  index: number
  agent_id: string | null
  agent_name: string | null
  kind: 'system' | 'agent'
  last_used_at: number
  idle_ms: number
}

export interface BrowserStatus {
  enabled: boolean
  mutex: { busy: boolean }
  tabs: BrowserStatusTab[]
  capacity: { used: number; agent_used: number; max: number }
  idle_timeout_ms: number
}

// ── Plan 20: multi-browser-profile ─────────────────────────────────────────

export interface BrowserAdapterConfigField {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'unknown'
  optional: boolean
  description?: string
  default?: unknown
  min?: number
  max?: number
  options?: string[]
  placeholder?: string
}

export interface BrowserAdapterInfo {
  id: string
  display_name: string
  description: string
  config_fields: Record<string, BrowserAdapterConfigField>
}

export interface BrowserProfile {
  id: string
  project_id: string
  name: string
  adapter_id: string
  config: Record<string, unknown>
  enabled: boolean
  is_default: boolean
  created_at: string
}

export interface BrowserProfileCreate {
  name: string
  adapter_id: string
  config?: Record<string, unknown>
  enabled?: boolean
  is_default?: boolean
}

export interface BrowserProfilePatch {
  name?: string
  config?: Record<string, unknown>
  enabled?: boolean
  is_default?: boolean
}

export interface PluginItem {
  id: string
  name: string
  description: string | null
  version: string
  author: string | null
  icon: string | null
  category: string | null
  project_scope: boolean | null
  config_schema: Record<string, unknown> | null
  created_at: string | null
  updated_at: string | null
  // project status overlay (when fetched via /projects/:pid/plugins)
  enabled?: boolean
  config?: Record<string, unknown>
  activated_at?: string | null
}

export interface ProjectPluginItem {
  id: string
  project_id: string
  plugin_id: string
  enabled: boolean | null
  config: Record<string, unknown> | null
  activated_at: string | null
}

export interface Company {
  id: string
  name: string
  slug: string
  owner_id: string
  created_at: string | null
}

export interface Project {
  id: string
  company_id: string
  name: string
  slug: string
  default_timezone?: string
  created_at: string | null
}

export interface Agent {
  id: string
  project_id: string
  name: string
  slug: string
  description: string | null
  base_prompt: string
  allowed_modes: string[]
  compaction_threshold?: number | null
  max_tool_calls?: number | null
  file_delivery?: 'base64' | 'proxy_url' | null
  attachment_scope?: 'per_user' | 'shared' | null
  /** null = allow all, [] = deny all, [id…] = allow specific agents */
  task_allowed_agents?: string[] | null
  cron_task_enabled?: boolean | null
  /** Queue mode: 'off' | 'queue' | 'ack_queue' */
  queue_mode?: string | null
  /** Auto-reply rules */
  auto_replies?: AutoReplyRule[] | null
  /** Availability schedule */
  availability_schedule?: AvailabilitySchedule | null
  /** Plan 19 — skill access resolution mode */
  skill_access_mode?: 'manual' | 'all_on_demand' | null
  /** Plan 24 — command access resolution mode */
  command_access_mode?: 'manual' | 'all' | null
  /** Plan 21 — per-mode adapter selection + config. */
  mode_configs?: Record<string, { adapter: string; config?: Record<string, unknown> }> | null
  created_at: string | null
}

/** Plan 21 — adapter info from GET /api/agents/adapters */
export interface AgentAdapterInfo {
  id: string
  displayName: string
  description: string
  configSchema: {
    type?: string
    properties?: Record<string, {
      type?: 'number' | 'string' | 'boolean'
      default?: unknown
      minimum?: number
      maximum?: number
      description?: string
    }>
  }
}

export interface AutoReplyRule {
  trigger: 'exact' | 'contains' | 'regex' | 'command'
  pattern: string
  response: string
  enabled: boolean
}

export interface ScheduleHours {
  days: number[]
  from: string
  to: string
}

export interface AvailabilitySchedule {
  enabled: boolean
  timezone: string
  hours: ScheduleHours[]
  offline_message: string
}

export type CronTaskMode = 'recurring' | 'once'
export type CronTaskStatus = 'active' | 'archived'

export interface CronTask {
  id: string
  project_id: string
  agent_id: string
  name: string
  description: string | null
  mode: CronTaskMode
  cron_expression: string | null
  run_at: string | null
  status: CronTaskStatus
  prompt: string
  enabled: boolean
  caller_id: string | null
  caller_role: string | null
  caller_is_superadmin: boolean
  last_run_at: string | null
  next_run_at: string | null
  run_count: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  agent?: { id: string; name: string; slug: string } | null
  caller?: { id: string; name: string; email: string } | null
}

export interface ProjectAttachment {
  id: string
  project_id: string
  agent_id: string | null
  conversation_id: string | null
  user_id: string | null
  storage_key: string
  filename: string
  mime_type: string
  size_bytes: number
  scope: string
  created_at: string
}

export interface ContextSegment {
  source: 'base_prompt' | 'mode' | 'user_context' | 'plugin' | 'memory' | 'tool_hint' | 'persona'
  label: string
  content: string
  token_estimate: number
}

export interface ProjectUsageLog extends UsageLog {
  agent?: { id: string; name: string; slug: string } | null
}

export interface UsageLog {
  id: string
  // Plan 19 — agent/conversation nullable for background LLM calls.
  agent_id: string | null
  conversation_id: string | null
  project_id: string | null
  user_id: string | null
  mode: string
  /** 'chat' | 'task' | 'title' | 'reflection' | 'dreaming.light|deep|rem' | 'flush' | 'compaction' | 'embedding' | 'plugin:<id>' | 'custom' */
  source: string
  provider_id: string | null
  model_id: string | null
  input_tokens: number
  output_tokens: number
  duration_ms: number | null
  raw_system_prompt: string | null
  raw_messages: unknown | null
  raw_response: string | null
  /** Debug — tool names actually registered at run time. */
  active_tools: string[] | null
  /** Debug — agent adapter id (e.g. 'jiku.agent.default'). */
  agent_adapter: string | null
  created_at: string
  user?: { id: string; name: string | null; email: string } | null
  conversation?: { id: string; mode: string; type: string } | null
}

export interface UsageSummary {
  total_input: number
  total_output: number
  total_runs: number
}

export interface ConversationContext {
  segments: ContextSegment[]
  total_tokens: number
  history_tokens: number
  grand_total: number
  model_context_window: number
  usage_percent: number
}

export interface PreviewRunResult {
  context: ConversationContext
  active_tools: {
    id: string
    name: string
    description: string
    permission: string
    has_prompt: boolean
    token_estimate: number
    input_schema?: unknown
    group?: string
  }[]
  active_plugins: {
    id: string
    name: string
    segments: { label: string; token_estimate: number }[]
  }[]
  system_prompt: string
  warnings: string[]
  compaction_count: number
  model_info?: {
    provider_id: string
    provider_name: string
    model_id: string
  }
  mode?: 'chat' | 'task'
  adapter_info?: {
    id: string
    display_name: string
    description?: string
    config?: Record<string, unknown>
  }
}

export interface PolicyCondition {
  attribute: string
  operator: 'eq' | 'not_eq' | 'in' | 'not_in' | 'contains' | 'not_contains'
  value: string | string[]
}

export interface PolicyRule {
  id: string
  policy_id: string
  resource_type: string
  resource_id: string
  subject_type: string
  subject: string
  effect: string
  priority: number | null
  conditions: PolicyCondition[] | null
}

export interface Policy {
  id: string
  company_id: string
  name: string
  description: string | null
  is_template: boolean | null
  created_at: string | null
  rules: PolicyRule[]
}

export interface AgentPolicyItem {
  agent_id: string
  policy_id: string
  priority: number | null
  policy: Policy
}

export interface UserPolicy {
  id: string
  agent_id: string
  user_id: string
  allowed_permissions: string[]
  updated_at: string | null
  user?: { id: string; name: string; email: string }
}

export interface ConversationItem {
  id: string
  agent_id: string
  user_id: string
  mode: string
  title: string | null
  status: string
  type: string
  run_status: string
  metadata: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  error_message: string | null
  created_at: string | null
}

export interface ConversationItemWithAgent extends ConversationItem {
  agent: { id: string; name: string; slug: string }
  last_message: string | null
  updated_at: string | null
}

export interface RunRow {
  id: string
  type: string
  run_status: string
  agent_id: string
  agent_name: string
  caller_id: string | null
  parent_conversation_id: string | null
  metadata: Record<string, unknown>
  message_count: number
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  error_message: string | null
  created_at: string
}

export interface RunsListResult {
  data: RunRow[]
  total: number
  page: number
  per_page: number
  total_pages: number
}

export interface HeartbeatConfig {
  heartbeat_enabled: boolean
  heartbeat_cron: string | null
  heartbeat_prompt: string | null
  heartbeat_last_run_at: string | null
  heartbeat_next_run_at: string | null
}

export interface AdapterField {
  key: string
  label: string
  type: 'secret' | 'string' | 'number' | 'boolean'
  required: boolean
  default?: string
  placeholder?: string
}

export interface AdapterModel {
  id: string
  name: string
  description?: string
  cost_per_million_out?: number
  cost_per_million_in?: number
}

export interface CredentialAdapter {
  group_id: string
  adapter_id: string
  name: string
  icon: string
  fields: AdapterField[]
  metadata: AdapterField[]
  models: AdapterModel[]
  requires_interactive_setup?: boolean
}

// ============================================================
// CONNECTOR INTERACTIVE SETUP (Plan 24 Phase 1)
// Inlined here (mirrored from @jiku/types) because api.ts does
// not currently import from @jiku/types; keep in sync manually.
// ============================================================

export interface ConnectorSetupInput {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  secret?: boolean
  label: string
  placeholder?: string
  description?: string
}

export interface ConnectorSetupStep {
  id: string
  title: string
  description: string
  inputs: ConnectorSetupInput[]
  conditional?: boolean
}

export interface ConnectorSetupSpec {
  steps: ConnectorSetupStep[]
  title?: string
  intro?: string
}

export type ConnectorSetupStepInputValue = string | number | boolean

export type ConnectorSetupStepResult =
  | { ok: true; next_step?: string; ui_message?: string }
  | { ok: true; complete: true; fields: Record<string, unknown>; ui_message?: string }
  | {
      ok: false
      error: string
      hint?: string
      retry_step?: string
      retry_count?: number
      max_retries?: number
      aborted?: boolean
      reason?: string
    }

export interface ConnectorSetupStartResponse {
  setup_session_id: string
  spec: ConnectorSetupSpec
  first_step_id: string
  max_retries_per_step: number
}

export interface CredentialItem {
  id: string
  name: string
  description: string | null
  group_id: string
  adapter_id: string
  scope: string
  scope_id: string
  metadata: Record<string, string>
  fields_masked: Record<string, string>
  adapter: CredentialAdapter | undefined
  created_at: string | null
}

export interface AgentCredentialItem {
  id: string
  agent_id: string
  credential: CredentialItem
  model_id: string | null
  metadata_override: Record<string, string>
}

export interface CreateCredentialBody {
  name: string
  description?: string
  adapter_id: string
  group_id: string
  fields?: Record<string, string>
  metadata?: Record<string, string>
}

export interface MemoryItem {
  id: string
  project_id: string
  agent_id: string | null
  caller_id: string | null
  scope: 'agent_caller' | 'agent_global' | 'runtime_global' | 'agent_self'
  tier: 'core' | 'extended'
  section: string | null
  content: string
  importance: 'low' | 'medium' | 'high'
  visibility: 'private' | 'agent_shared' | 'project_shared'
  source: 'agent' | 'extraction'
  // Plan 19
  memory_type?: 'episodic' | 'semantic' | 'procedural' | 'reflective'
  source_type?: 'tool' | 'reflection' | 'dream' | 'flush'
  score_health?: number
  access_count: number
  last_accessed: string | null
  expires_at: string | null
  created_at: string | null
  updated_at: string | null
}

export interface ResolvedMemoryConfig {
  policy: {
    read: { runtime_global: boolean; cross_user: boolean }
    write: { agent_global: boolean; runtime_global: boolean; cross_user: boolean }
  }
  relevance: {
    min_score: number
    max_extended: number
    weights: { keyword: number; semantic?: number; recency: number; access: number }
    recency_half_life_days: number
  }
  core: { max_chars: number; token_budget: number }
  extraction: { enabled: boolean; model: string; target_scope: 'agent_caller' | 'agent_global' | 'both' }
  embedding: {
    enabled: boolean
    provider: string
    model: string
    credential_id: string | null
    dimensions: number
  }
  // Plan 19 — dreaming engine (project-level)
  dreaming?: {
    enabled: boolean
    credential_id: string | null
    model_id: string
    light: { enabled: boolean; cron: string; credential_id: string | null; model_id: string }
    deep:  { enabled: boolean; cron: string; credential_id: string | null; model_id: string }
    rem:   { enabled: boolean; cron: string; credential_id: string | null; model_id: string; min_pattern_strength: number }
  }
}

export type AgentMemoryConfig = {
  policy?: {
    read?: Partial<ResolvedMemoryConfig['policy']['read']>
    write?: Partial<ResolvedMemoryConfig['policy']['write']>
  }
  relevance?: Partial<ResolvedMemoryConfig['relevance']> & {
    weights?: Partial<ResolvedMemoryConfig['relevance']['weights']>
  }
  core?: Partial<ResolvedMemoryConfig['core']>
  extraction?: Partial<ResolvedMemoryConfig['extraction']>
  embedding?: Partial<ResolvedMemoryConfig['embedding']>
  // Plan 19 — per-agent post-run reflection override
  reflection?: {
    enabled?: boolean
    model?: string
    scope?: 'agent_caller' | 'agent_global'
    min_conversation_turns?: number
  }
}

export interface PersonaTraits {
  formality: 'casual' | 'balanced' | 'formal'
  verbosity: 'concise' | 'moderate' | 'detailed'
  humor: 'none' | 'light' | 'frequent'
  empathy: 'low' | 'moderate' | 'high'
  expertise_display: 'simplified' | 'balanced' | 'technical'
}

export interface PersonaSeed {
  name?: string
  role?: string
  personality?: string
  communication_style?: string
  background?: string
  initial_memories?: string[]
  /** Structured communication traits. */
  traits?: PersonaTraits
  /** Hard boundaries — things the agent refuses to do. */
  boundaries?: string[]
}

export interface ConnectorPlugin {
  id: string
  display_name: string
  credential_adapter_id: string
  ref_keys: string[]
  supported_events: string[]
}

export interface ConnectorItem {
  id: string
  project_id: string
  plugin_id: string
  display_name: string
  credential_id?: string | null
  config: Record<string, unknown>
  /** Match mode: 'all' = execute all matching bindings, 'first' = first match wins. */
  match_mode?: 'all' | 'first'
  /** Fallback agent when no binding matches. */
  default_agent_id?: string | null
  status: 'active' | 'inactive' | 'error'
  error_message?: string | null
  created_at: string
  updated_at: string
}

export interface ConnectorBinding {
  id: string
  connector_id: string
  display_name?: string | null
  source_type: string
  source_ref_keys?: Record<string, string> | null
  trigger_source: string
  trigger_mode: string
  trigger_keywords?: string[] | null
  trigger_keywords_regex?: boolean
  trigger_mention_tokens?: string[] | null
  trigger_commands?: string[] | null
  trigger_event_type?: string | null
  trigger_event_filter?: Record<string, unknown> | null
  /** Routing priority — higher wins. Default 0. */
  priority?: number
  /** Regex pattern matched against message text. */
  trigger_regex?: string | null
  /** Schedule filter (AvailabilitySchedule shape). */
  schedule_filter?: Record<string, unknown> | null
  output_adapter: string
  output_config: Record<string, unknown>
  rate_limit_rpm?: number | null
  include_sender_info: boolean
  /** Plan 22 — Scope filter: null = all, "group:*", "dm:*", exact */
  scope_key_pattern?: string | null
  /** How new members in a group/channel scope are admitted. DM bindings ignore this. */
  member_mode?: 'require_approval' | 'allow_all'
  enabled: boolean
  created_at: string
}

export interface ConnectorTargetItem {
  id: string
  connector_id: string
  name: string
  display_name?: string | null
  description?: string | null
  ref_keys: Record<string, string>
  scope_key?: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ConnectorScopeItem {
  id: string
  connector_id: string
  scope_key: string
  agent_id?: string | null
  conversation_id?: string | null
  last_activity_at: string
  created_at: string
}

export interface ConversationOutputConfig {
  agent_id: string
  conversation_mode?: 'persistent' | 'new'
}

export interface TaskOutputConfig {
  agent_id: string
}

export interface ConnectorIdentity {
  id: string
  connector_id: string
  binding_id?: string | null
  external_ref_keys: Record<string, string>
  display_name?: string | null
  avatar_url?: string | null
  status: 'pending' | 'approved' | 'blocked'
  approved_by?: string | null
  approved_at?: string | null
  mapped_user_id?: string | null
  conversation_id?: string | null
  last_seen_at?: string | null
  created_at: string
}

export interface ConnectorInviteCode {
  id: string
  connector_id: string
  code: string
  label?: string | null
  max_uses?: number | null
  use_count: number
  expires_at?: string | null
  revoked: boolean
  created_by?: string | null
  created_at: string
}

export interface ConnectorEventFilters {
  connector_id?: string
  event_type?: string
  direction?: 'inbound' | 'outbound'
  status?: string
  from?: string  // ISO
  to?: string
  cursor?: string | null
  limit?: number
  [k: string]: unknown
}

export interface ConnectorMessageFilters {
  connector_id?: string
  direction?: 'inbound' | 'outbound'
  status?: string
  from?: string
  to?: string
  cursor?: string | null
  limit?: number
  [k: string]: unknown
}

function buildConnectorListQuery(f: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '') continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export interface ConnectorEventListItem extends ConnectorEventItem {
  connector_name: string
}

export interface ConnectorMessageListItem extends ConnectorMessageItem {
  connector_name: string
}

export interface ConnectorEventItem {
  id: string
  connector_id: string
  binding_id?: string | null
  identity_id?: string | null
  event_type: string
  direction: 'inbound' | 'outbound'
  ref_keys: Record<string, string>
  target_ref_keys?: Record<string, string> | null
  payload: Record<string, unknown>
  raw_payload?: unknown | null
  metadata?: Record<string, unknown> | null
  status: string
  drop_reason?: string | null
  processing_ms?: number | null
  created_at: string
}

export interface ConnectorMessageItem {
  id: string
  connector_id: string
  conversation_id?: string | null
  direction: 'inbound' | 'outbound'
  ref_keys: Record<string, string>
  content_snapshot?: string | null
  raw_payload?: unknown | null
  status: string
  created_at: string
}

// ─── ACL Types (Plan 12) ──────────────────────────────────────────────────────

export interface ProjectRole {
  id: string
  project_id: string
  name: string
  description: string | null
  permissions: string[]
  is_default: boolean
  member_count?: number
  created_at: string
  updated_at: string
}

export interface ProjectMembership {
  id: string
  project_id: string
  user_id: string
  role_id: string | null
  is_superadmin: boolean
  agent_restrictions: Record<string, boolean>
  tool_restrictions: Record<string, Record<string, boolean>>
  joined_at: string
}

export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  role_id: string | null
  is_superadmin: boolean
  agent_restrictions: Record<string, boolean>
  tool_restrictions: Record<string, Record<string, boolean>>
  joined_at: string
  user: { id: string; name: string; email: string }
  role: ProjectRole | null
}

export interface ResolvedProjectPermissions {
  granted: boolean
  isSuperadmin: boolean
  permissions: string[]
  agentRestrictions: Record<string, boolean>
  toolRestrictions: Record<string, Record<string, boolean>>
}

export interface MemberProjectItem {
  id: string
  project_id: string
  user_id: string
  role_id: string | null
  is_superadmin: boolean
  joined_at: string
  role: ProjectRole | null
  project: { id: string; name: string; slug: string; company_id: string }
}

export interface CompanyMemberItem {
  id: string
  company_id: string
  user_id: string
  role_id: string
  joined_at: string
  user: { id: string; name: string; email: string }
  role: { id: string; name: string; is_system: boolean }
}

export interface InvitationItem {
  id: string
  company_id: string
  email: string
  project_grants: Array<{ project_id: string; role_id: string }>
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'
  invited_by: string
  expires_at: string
  accepted_by: string | null
  accepted_at: string | null
  created_at: string
  company?: { id: string; name: string; slug: string }
  invited_by_user?: { id: string; name: string; email: string }
}

export interface SkillItem {
  id: string
  project_id: string
  name: string
  slug: string
  description: string | null
  tags: string[]
  entrypoint: string
  enabled: boolean
  // Plan 19
  source?: string           // 'fs' | `plugin:<id>`
  plugin_id?: string | null
  active?: boolean
  manifest?: unknown
  last_synced_at?: string | null
  created_at: string
  updated_at: string
}

export interface AgentSkillAssignment {
  id: string
  agent_id: string
  skill_id: string
  mode: 'always' | 'on_demand'
  created_at: string
  skill: SkillItem
}

export interface CommandItem {
  id: string
  project_id: string
  slug: string
  name: string
  description: string | null
  tags: string[]
  entrypoint: string
  args_schema?: unknown
  manifest?: { metadata?: { jiku?: { emoji?: string } } } | unknown
  manifest_hash?: string | null
  source: string           // 'fs' | `plugin:<id>`
  plugin_id?: string | null
  enabled: boolean
  active: boolean
  last_synced_at?: string | null
  created_at: string
  updated_at: string
}

export interface AgentCommandAssignment {
  id: string
  agent_id: string
  command_id: string
  pinned: boolean
  created_at: string
  command: CommandItem
}

export interface McpServerItem {
  id: string
  project_id: string
  agent_id?: string | null
  name: string
  transport: string
  config: Record<string, unknown>
  enabled: boolean
  connected?: boolean
  tool_count?: number
  created_at: string
  updated_at: string
}

