import { definePlugin } from '@jiku/kit'

/**
 * Built-in system plugin injected by Jiku Studio server.
 * Always active for all projects — informs the agent it is running inside Jiku Studio.
 */
export const JikuStudioPlugin = definePlugin({
  meta: {
    id: 'jiku.studio',
    name: 'Jiku Studio',
    version: '1.0.0',
    description: 'Built-in context plugin for Jiku Studio. Injects platform awareness into every agent.',
    author: 'Jiku',
    icon: 'LayoutDashboard',
    category: 'system',
    // No project_scope → system plugin, always active for all projects
    // project_scope: true,
  },

  setup(ctx) {
    ctx.project.prompt.inject(
      'You are running inside Jiku Studio — a unified platform for managing and running AI agents. ' +
      'Jiku Studio allows users to configure agents, manage conversations, enable plugins, and define policies. ' +
      'When relevant, you may reference Jiku Studio features to help the user accomplish their goals.'
    )
  },
})
