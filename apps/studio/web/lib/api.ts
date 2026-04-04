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
    create: (body: { name: string; slug: string }) =>
      request<{ company: Company }>('/api/companies', { method: 'POST', body: JSON.stringify(body) }),
  },

  projects: {
    list: (companyId: string) => request<{ projects: Project[] }>(`/api/companies/${companyId}/projects`),
    create: (companyId: string, body: { name: string; slug: string }) =>
      request<{ project: Project }>(`/api/companies/${companyId}/projects`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    delete: (companyId: string, projectId: string) =>
      request<{ ok: boolean }>(`/api/companies/${companyId}/projects/${projectId}`, { method: 'DELETE' }),
  },

  agents: {
    list: (projectId: string) => request<{ agents: Agent[] }>(`/api/projects/${projectId}/agents`),
    create: (projectId: string, body: Omit<Agent, 'id' | 'project_id' | 'created_at'>) =>
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
    create: (agentId: string, body?: { mode?: string }) =>
      request<{ conversation: ConversationItem }>(`/api/agents/${agentId}/conversations`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
  },
}

// Types
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
  description: string | null
  base_prompt: string
  allowed_modes: string[]
  provider_id: string
  model_id: string
  created_at: string | null
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
