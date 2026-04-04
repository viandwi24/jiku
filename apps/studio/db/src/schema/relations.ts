import { relations } from 'drizzle-orm'
import { users } from './users.ts'
import { companies } from './companies.ts'
import { roles, company_members } from './roles.ts'
import { permissions, role_permissions } from './permissions.ts'
import { projects } from './projects.ts'
import { agents } from './agents.ts'
import { policies, policy_rules, agent_policies, agent_user_policies } from './policies.ts'
import { conversations, messages } from './conversations.ts'
import { credentials, agent_credentials } from './credentials.ts'

export const usersRelations = relations(users, ({ many }) => ({
  companies: many(companies),
  company_members: many(company_members),
  agent_user_policies: many(agent_user_policies),
  conversations: many(conversations),
  credentials: many(credentials),
}))

export const companiesRelations = relations(companies, ({ one, many }) => ({
  owner: one(users, { fields: [companies.owner_id], references: [users.id] }),
  roles: many(roles),
  company_members: many(company_members),
  projects: many(projects),
  policies: many(policies),
}))

export const rolesRelations = relations(roles, ({ one, many }) => ({
  company: one(companies, { fields: [roles.company_id], references: [companies.id] }),
  role_permissions: many(role_permissions),
  company_members: many(company_members),
}))

export const companyMembersRelations = relations(company_members, ({ one }) => ({
  company: one(companies, { fields: [company_members.company_id], references: [companies.id] }),
  user: one(users, { fields: [company_members.user_id], references: [users.id] }),
  role: one(roles, { fields: [company_members.role_id], references: [roles.id] }),
}))

export const permissionsRelations = relations(permissions, ({ many }) => ({
  role_permissions: many(role_permissions),
}))

export const rolePermissionsRelations = relations(role_permissions, ({ one }) => ({
  role: one(roles, { fields: [role_permissions.role_id], references: [roles.id] }),
  permission: one(permissions, { fields: [role_permissions.permission_id], references: [permissions.id] }),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  company: one(companies, { fields: [projects.company_id], references: [companies.id] }),
  agents: many(agents),
}))

export const agentsRelations = relations(agents, ({ one, many }) => ({
  project: one(projects, { fields: [agents.project_id], references: [projects.id] }),
  agent_policies: many(agent_policies),
  agent_user_policies: many(agent_user_policies),
  conversations: many(conversations),
  agent_credential: many(agent_credentials),
}))

export const credentialsRelations = relations(credentials, ({ one, many }) => ({
  created_by_user: one(users, { fields: [credentials.created_by], references: [users.id] }),
  agent_credentials: many(agent_credentials),
}))

export const agentCredentialsRelations = relations(agent_credentials, ({ one }) => ({
  agent: one(agents, { fields: [agent_credentials.agent_id], references: [agents.id] }),
  credential: one(credentials, { fields: [agent_credentials.credential_id], references: [credentials.id] }),
}))

export const policiesRelations = relations(policies, ({ one, many }) => ({
  company: one(companies, { fields: [policies.company_id], references: [companies.id] }),
  rules: many(policy_rules),
  agent_policies: many(agent_policies),
}))

export const policyRulesRelations = relations(policy_rules, ({ one }) => ({
  policy: one(policies, { fields: [policy_rules.policy_id], references: [policies.id] }),
}))

export const agentPoliciesRelations = relations(agent_policies, ({ one }) => ({
  agent: one(agents, { fields: [agent_policies.agent_id], references: [agents.id] }),
  policy: one(policies, { fields: [agent_policies.policy_id], references: [policies.id] }),
}))

export const agentUserPoliciesRelations = relations(agent_user_policies, ({ one }) => ({
  agent: one(agents, { fields: [agent_user_policies.agent_id], references: [agents.id] }),
  user: one(users, { fields: [agent_user_policies.user_id], references: [users.id] }),
}))

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  agent: one(agents, { fields: [conversations.agent_id], references: [agents.id] }),
  user: one(users, { fields: [conversations.user_id], references: [users.id] }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversation_id], references: [conversations.id] }),
}))
