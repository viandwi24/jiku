import { and, eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { policies, policy_rules, agent_policies, agent_user_policies, agents } from '../schema/index.ts'
import type { NewPolicy, NewPolicyRule, AgentPolicy } from '../schema/index.ts'
import type { PolicyRule } from '@jiku/types'

// ── Policies ─────────────────────────────────────────────────────────────────

export async function getPolicies(companyId: string) {
  return db.query.policies.findMany({
    where: eq(policies.company_id, companyId),
    with: { rules: true },
  })
}

export async function getPolicyById(id: string) {
  return db.query.policies.findFirst({
    where: eq(policies.id, id),
    with: { rules: true },
  })
}

export async function createPolicy(data: Omit<NewPolicy, 'id' | 'created_at'>) {
  const [policy] = await db.insert(policies).values(data).returning()
  return policy!
}

export async function updatePolicy(id: string, data: Partial<Omit<NewPolicy, 'id' | 'created_at'>>) {
  const [policy] = await db.update(policies).set(data).where(eq(policies.id, id)).returning()
  return policy!
}

export async function deletePolicy(id: string) {
  await db.delete(policies).where(eq(policies.id, id))
}

// ── Policy Rules ──────────────────────────────────────────────────────────────

export async function getPolicyRules(policyId: string) {
  return db.query.policy_rules.findMany({
    where: eq(policy_rules.policy_id, policyId),
    orderBy: (t, { desc }) => [desc(t.priority)],
  })
}

export async function createPolicyRule(data: Omit<NewPolicyRule, 'id'>) {
  const [rule] = await db.insert(policy_rules).values(data).returning()
  return rule!
}

export async function deletePolicyRule(id: string) {
  await db.delete(policy_rules).where(eq(policy_rules.id, id))
}

// ── Agent ↔ Policy attachment ─────────────────────────────────────────────────

export async function getAgentPolicies(agentId: string) {
  return db.query.agent_policies.findMany({
    where: eq(agent_policies.agent_id, agentId),
    with: { policy: { with: { rules: true } } },
    orderBy: (t, { desc }) => [desc(t.priority)],
  })
}

export async function attachPolicy(agentId: string, policyId: string, priority = 0) {
  const [row] = await db
    .insert(agent_policies)
    .values({ agent_id: agentId, policy_id: policyId, priority })
    .onConflictDoUpdate({
      target: [agent_policies.agent_id, agent_policies.policy_id],
      set: { priority },
    })
    .returning()
  return row!
}

export async function detachPolicy(agentId: string, policyId: string) {
  await db.delete(agent_policies).where(
    and(
      eq(agent_policies.agent_id, agentId),
      eq(agent_policies.policy_id, policyId),
    ),
  )
}

// ── Load all rules for a project (used by JikuRuntime) ───────────────────────
// Returns a map: agentId → PolicyRule[]

export async function loadProjectPolicyRules(projectId: string): Promise<Map<string, PolicyRule[]>> {
  const rows = await db.query.agents.findMany({
    where: eq(agents.project_id, projectId),
    with: {
      agent_policies: {
        with: {
          policy: { with: { rules: true } },
        },
        orderBy: (t, { desc }) => [desc(t.priority)],
      },
    },
  })

  const result = new Map<string, PolicyRule[]>()
  for (const agent of rows) {
    const rules: PolicyRule[] = []
    for (const ap of agent.agent_policies) {
      for (const r of ap.policy.rules) {
        rules.push({
          resource_type: r.resource_type,
          resource_id:   r.resource_id,
          subject_type:  r.subject_type,
          subject:       r.subject,
          effect:        r.effect as PolicyRule['effect'],
          priority:      r.priority ?? 0,
          conditions:    (r.conditions as PolicyRule['conditions']) ?? [],
        })
      }
    }
    result.set(agent.id, rules)
  }
  return result
}

// ── Agent User Policies ───────────────────────────────────────────────────────

export async function getAgentUserPolicy(agentId: string, userId: string) {
  return db.query.agent_user_policies.findFirst({
    where: and(
      eq(agent_user_policies.agent_id, agentId),
      eq(agent_user_policies.user_id, userId),
    ),
  })
}

export async function getUserPoliciesForAgent(agentId: string) {
  return db.query.agent_user_policies.findMany({
    where: eq(agent_user_policies.agent_id, agentId),
    with: { user: true },
  })
}

export async function upsertAgentUserPolicy(agentId: string, userId: string, allowedPermissions: string[]) {
  const [policy] = await db
    .insert(agent_user_policies)
    .values({ agent_id: agentId, user_id: userId, allowed_permissions: allowedPermissions })
    .onConflictDoUpdate({
      target: [agent_user_policies.agent_id, agent_user_policies.user_id],
      set: { allowed_permissions: allowedPermissions, updated_at: new Date() },
    })
    .returning()
  return policy!
}
