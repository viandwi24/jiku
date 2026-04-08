import type { ProjectMemoryConfig, ResolvedMemoryConfig, AgentMemoryConfig } from '@jiku/types'

export const DEFAULT_PROJECT_MEMORY_CONFIG: ProjectMemoryConfig = {
  policy: {
    read: {
      runtime_global: true,
      cross_user: false,
    },
    write: {
      agent_global: true,
      runtime_global: false,
      cross_user: false,
    },
  },
  relevance: {
    min_score: 0.05,
    max_extended: 5,
    weights: {
      keyword: 0.25,
      semantic: 0.35,
      recency: 0.25,
      access: 0.15,
    },
    recency_half_life_days: 30,
  },
  core: {
    max_chars: 2000,
    token_budget: 600,
  },
  extraction: {
    enabled: false,
    model: 'claude-haiku-4-5',
    target_scope: 'agent_caller',
  },
  embedding: {
    enabled: false,
    provider: '',
    model: '',
    credential_id: null,
    dimensions: 1536,
  },
}

export function resolveMemoryConfig(
  projectConfig: ProjectMemoryConfig,
  agentConfig: AgentMemoryConfig | null | undefined,
): ResolvedMemoryConfig {
  if (!agentConfig) return projectConfig

  return {
    policy: {
      read: {
        runtime_global: agentConfig.policy?.read?.runtime_global
          ?? projectConfig.policy.read.runtime_global,
        cross_user: agentConfig.policy?.read?.cross_user
          ?? projectConfig.policy.read.cross_user,
      },
      write: {
        agent_global: agentConfig.policy?.write?.agent_global
          ?? projectConfig.policy.write.agent_global,
        runtime_global: agentConfig.policy?.write?.runtime_global
          ?? projectConfig.policy.write.runtime_global,
        cross_user: agentConfig.policy?.write?.cross_user
          ?? projectConfig.policy.write.cross_user,
      },
    },
    relevance: {
      min_score: agentConfig.relevance?.min_score
        ?? projectConfig.relevance.min_score,
      max_extended: agentConfig.relevance?.max_extended
        ?? projectConfig.relevance.max_extended,
      weights: {
        keyword: agentConfig.relevance?.weights?.keyword
          ?? projectConfig.relevance?.weights?.keyword ?? DEFAULT_PROJECT_MEMORY_CONFIG.relevance.weights.keyword,
        semantic: agentConfig.relevance?.weights?.semantic
          ?? projectConfig.relevance?.weights?.semantic ?? DEFAULT_PROJECT_MEMORY_CONFIG.relevance.weights.semantic,
        recency: agentConfig.relevance?.weights?.recency
          ?? projectConfig.relevance?.weights?.recency ?? DEFAULT_PROJECT_MEMORY_CONFIG.relevance.weights.recency,
        access: agentConfig.relevance?.weights?.access
          ?? projectConfig.relevance?.weights?.access ?? DEFAULT_PROJECT_MEMORY_CONFIG.relevance.weights.access,
      },
      recency_half_life_days: agentConfig.relevance?.recency_half_life_days
        ?? projectConfig.relevance.recency_half_life_days,
    },
    core: {
      max_chars: agentConfig.core?.max_chars
        ?? projectConfig.core.max_chars,
      token_budget: agentConfig.core?.token_budget
        ?? projectConfig.core.token_budget,
    },
    extraction: {
      enabled: agentConfig.extraction?.enabled
        ?? projectConfig.extraction?.enabled ?? DEFAULT_PROJECT_MEMORY_CONFIG.extraction.enabled,
      model: agentConfig.extraction?.model
        ?? projectConfig.extraction?.model ?? DEFAULT_PROJECT_MEMORY_CONFIG.extraction.model,
      target_scope: agentConfig.extraction?.target_scope
        ?? projectConfig.extraction?.target_scope ?? DEFAULT_PROJECT_MEMORY_CONFIG.extraction.target_scope,
    },
    embedding: {
      enabled: agentConfig.embedding?.enabled
        ?? projectConfig.embedding?.enabled ?? DEFAULT_PROJECT_MEMORY_CONFIG.embedding.enabled,
      provider: agentConfig.embedding?.provider
        ?? projectConfig.embedding?.provider ?? DEFAULT_PROJECT_MEMORY_CONFIG.embedding.provider,
      model: agentConfig.embedding?.model
        ?? projectConfig.embedding?.model ?? DEFAULT_PROJECT_MEMORY_CONFIG.embedding.model,
      credential_id: agentConfig.embedding?.credential_id
        ?? projectConfig.embedding?.credential_id ?? DEFAULT_PROJECT_MEMORY_CONFIG.embedding.credential_id,
      dimensions: agentConfig.embedding?.dimensions
        ?? projectConfig.embedding?.dimensions ?? DEFAULT_PROJECT_MEMORY_CONFIG.embedding.dimensions,
    },
  }
}
