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
import { usage_logs } from './usage_logs.ts'
import { project_filesystem_config, project_files } from './filesystem.ts'
import { project_attachments } from './attachments.ts'
import { project_roles, project_memberships, invitations, superadmin_transfers } from './acl.ts'
import { cron_tasks } from './cron_tasks.ts'

export const usersRelations = relations(users, ({ many }) => ({
  companies: many(companies),
  company_members: many(company_members),
  project_memberships: many(project_memberships),
  agent_user_policies: many(agent_user_policies),
  conversations: many(conversations),
  credentials: many(credentials),
  sent_invitations: many(invitations, { relationName: 'invited_by' }),
}))

export const companiesRelations = relations(companies, ({ one, many }) => ({
  owner: one(users, { fields: [companies.owner_id], references: [users.id] }),
  roles: many(roles),
  company_members: many(company_members),
  projects: many(projects),
  policies: many(policies),
  invitations: many(invitations),
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
  filesystem_config: many(project_filesystem_config),
  files: many(project_files),
  project_roles: many(project_roles),
  project_memberships: many(project_memberships),
}))

export const projectRolesRelations = relations(project_roles, ({ one, many }) => ({
  project: one(projects, { fields: [project_roles.project_id], references: [projects.id] }),
  memberships: many(project_memberships),
}))

export const projectMembershipsRelations = relations(project_memberships, ({ one }) => ({
  project: one(projects, { fields: [project_memberships.project_id], references: [projects.id] }),
  user: one(users, { fields: [project_memberships.user_id], references: [users.id] }),
  role: one(project_roles, { fields: [project_memberships.role_id], references: [project_roles.id] }),
}))

export const invitationsRelations = relations(invitations, ({ one }) => ({
  company: one(companies, { fields: [invitations.company_id], references: [companies.id] }),
  invited_by_user: one(users, { fields: [invitations.invited_by], references: [users.id] }),
  accepted_by_user: one(users, { fields: [invitations.accepted_by], references: [users.id] }),
}))

export const superadminTransfersRelations = relations(superadmin_transfers, ({ one }) => ({
  project: one(projects, { fields: [superadmin_transfers.project_id], references: [projects.id] }),
  from_user: one(users, { fields: [superadmin_transfers.from_user_id], references: [users.id] }),
  to_user: one(users, { fields: [superadmin_transfers.to_user_id], references: [users.id] }),
}))

export const projectFilesystemConfigRelations = relations(project_filesystem_config, ({ one }) => ({
  project: one(projects, { fields: [project_filesystem_config.project_id], references: [projects.id] }),
}))

export const projectFilesRelations = relations(project_files, ({ one }) => ({
  project: one(projects, { fields: [project_files.project_id], references: [projects.id] }),
  created_by_user: one(users, { fields: [project_files.created_by], references: [users.id] }),
  updated_by_user: one(users, { fields: [project_files.updated_by], references: [users.id] }),
}))

export const agentsRelations = relations(agents, ({ one, many }) => ({
  project: one(projects, { fields: [agents.project_id], references: [projects.id] }),
  agent_policies: many(agent_policies),
  agent_user_policies: many(agent_user_policies),
  conversations: many(conversations),
  agent_credential: many(agent_credentials),
  usage_logs: many(usage_logs),
  attachments: many(project_attachments),
  cron_tasks: many(cron_tasks),
}))

export const cronTasksRelations = relations(cron_tasks, ({ one }) => ({
  project: one(projects, { fields: [cron_tasks.project_id], references: [projects.id] }),
  agent: one(agents, { fields: [cron_tasks.agent_id], references: [agents.id] }),
  caller: one(users, { fields: [cron_tasks.caller_id], references: [users.id] }),
}))

export const projectAttachmentsRelations = relations(project_attachments, ({ one }) => ({
  project: one(projects, { fields: [project_attachments.project_id], references: [projects.id] }),
  agent: one(agents, { fields: [project_attachments.agent_id], references: [agents.id] }),
  conversation: one(conversations, { fields: [project_attachments.conversation_id], references: [conversations.id] }),
  user: one(users, { fields: [project_attachments.user_id], references: [users.id] }),
}))

export const usageLogsRelations = relations(usage_logs, ({ one }) => ({
  agent: one(agents, { fields: [usage_logs.agent_id], references: [agents.id] }),
  conversation: one(conversations, { fields: [usage_logs.conversation_id], references: [conversations.id] }),
  user: one(users, { fields: [usage_logs.user_id], references: [users.id] }),
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
