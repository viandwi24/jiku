// Plan 17 — isolated plugin UI runtime.
//
// Each plugin entry module default-exports a `Mountable` produced by
// `defineMountable(Component)`. The host calls `mountable.mount(el, ctx, meta)`
// which creates a React root OWNED by the plugin (bundled into its own dist),
// renders the component, and returns a cleanup fn.

import type { ComponentType, ReactNode } from 'react'
import type { PluginContext } from './context-types.ts'

export type PluginUnmount = () => void
export type PluginMountFn = (
  el: HTMLElement,
  ctx: PluginContext,
  meta: Record<string, unknown>,
  subPath?: string,
) => PluginUnmount | Promise<PluginUnmount>

export interface Mountable {
  mount: PluginMountFn
}

export interface PluginComponentProps<C extends PluginContext = PluginContext> {
  ctx: C
  meta: Record<string, unknown>
  subPath?: string
  children?: ReactNode
}

/**
 * Wrap a React component so the host can mount it as a standalone island.
 *
 * Generic over the context shape — plugins targeting a specific host (Studio,
 * for example) can type their components with an extended context by passing
 * `StudioPluginContext` from `@jiku-plugin/studio`:
 *
 * @example
 * import type { StudioComponentProps } from '@jiku-plugin/studio'
 * function Dashboard({ ctx }: StudioComponentProps) { ctx.studio.api.get(...) }
 * export default defineMountable(Dashboard)
 */
export function defineMountable<C extends PluginContext = PluginContext>(
  Component: ComponentType<PluginComponentProps<C>>,
): Mountable {
  return {
    mount: async (el, ctx, meta, subPath) => {
      const [{ createRoot }, React] = await Promise.all([
        import('react-dom/client'),
        import('react'),
      ])
      const root = createRoot(el)
      root.render(
        React.createElement(Component as ComponentType<PluginComponentProps>, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: ctx as any,
          meta,
          subPath,
        }),
      )
      return () => root.unmount()
    },
  }
}
