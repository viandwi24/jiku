import { definePlugin, ConnectorAdapter } from '@jiku/kit'

export type { ConnectorAdapter }

export interface ConnectorPluginContext {
  connector: {
    register: (adapter: ConnectorAdapter) => void
  }
}

// Mutable ref so contributes() closure and setup() share the same pointer
let _registerFn: (adapter: ConnectorAdapter) => void = (_adapter) => {
  console.warn('[jiku.connector] register() called before setup — adapter registration may be lost')
}

export default definePlugin({
  meta: {
    id: 'jiku.connector',
    name: 'Connector',
    version: '1.0.0',
    description: 'Core connector plugin — provides ctx.connector.register() for connector adapter plugins.',
    author: 'Jiku',
    icon: 'plug',
    category: 'core',
  },
  contributes: () => ({
    connector: {
      register: (adapter: ConnectorAdapter) => _registerFn(adapter),
    },
  }),
  setup(ctx) {
    // Wire the mutable ref to the actual hook caller now that hookAPI is available
    _registerFn = (adapter: ConnectorAdapter) => {
      ctx.hooks.callHook('connector:register', adapter).catch(() => {})
    }
  },
})
