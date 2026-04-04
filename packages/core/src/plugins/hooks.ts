import { createHooks } from 'hookable'
import type { HookAPI } from '@jiku/types'

export function createHookAPI(): HookAPI {
  const hooks = createHooks()
  return {
    hook(event: string, handler: (payload: unknown) => Promise<void>) {
      hooks.hook(event, handler)
    },
    async callHook(event: string, payload?: unknown) {
      await hooks.callHook(event, payload)
    },
  }
}
