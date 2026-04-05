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
    update: (projectId: string, body: { name?: string; slug?: string }) =>
      request<{ project: Project }>(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (companyId: string, projectId: string) =>
      request<{ ok: boolean }>(`/api/companies/${companyId}/projects/${projectId}`, { method: 'DELETE' }),
  },

  agents: {
    list: (projectId: string) => request<{ agents: Agent[] }>(`/api/projects/${projectId}/agents`),
    create: (projectId: string, body: Omit<Agent, 'id' | 'project_id' | 'created_at' | 'slug'> & { slug?: string }) =>
      request<{ agent: Agent }>(`/api/projects/${projectId}/agents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (agentId: string, body: Partial<Agent>) =>
      request<{ agent: Agent }>(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (agentId: string) =>
      request<{ ok: boolean }>(`/api/agents/${agentId}`, { method: 'DELETE' }),
    preview: (agentId: string, body: { mode?: 'chat' | 'task' }) =>
      request<PreviewRunResult>(`/api/agents/${agentId}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
      request<{ messages: { id: string; role: string; parts: { type: string; [key: string]: unknown }[]; created_at: string | null }[] }>(`/api/conversations/${convId}/messages`),
    preview: (convId: string, body: { mode?: 'chat' | 'task' }) =>
      request<PreviewRunResult>(`/api/conversations/${convId}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    status: (convId: string) =>
      request<{ running: boolean }>(`/api/conversations/${convId}/status`),
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
}

// Types
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
  created_at: string | null
}

export interface ContextSegment {
  source: 'base_prompt' | 'mode' | 'user_context' | 'plugin' | 'memory' | 'tool_hint'
  label: string
  content: string
  token_estimate: number
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
    permission: string
    has_prompt: boolean
    token_estimate: number
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
  created_at: string | null
}

export interface ConversationItemWithAgent extends ConversationItem {
  agent: { id: string; name: string; slug: string }
  last_message: string | null
  updated_at: string | null
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
}

export interface CredentialAdapter {
  group_id: string
  adapter_id: string
  name: string
  icon: string
  fields: AdapterField[]
  metadata: AdapterField[]
  models: AdapterModel[]
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
  scope: 'agent_caller' | 'agent_global' | 'runtime_global'
  tier: 'core' | 'extended'
  section: string | null
  content: string
  importance: 'low' | 'medium' | 'high'
  visibility: 'private' | 'agent_shared' | 'project_shared'
  source: 'agent' | 'extraction'
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
    weights: { keyword: number; recency: number; access: number }
    recency_half_life_days: number
  }
  core: { max_chars: number; token_budget: number }
  extraction: { enabled: boolean; model: string; target_scope: 'agent_caller' | 'agent_global' | 'both' }
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
}
