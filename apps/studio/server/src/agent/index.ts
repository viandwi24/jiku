// Side-effect: register built-in agent adapters on server start.
import { DefaultAgentAdapter, HarnessAgentAdapter } from '@jiku/core'
import { agentAdapterRegistry } from './adapter-registry.ts'

agentAdapterRegistry.register(new DefaultAgentAdapter())
agentAdapterRegistry.register(new HarnessAgentAdapter())
