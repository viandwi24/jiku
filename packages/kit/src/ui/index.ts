// @jiku/kit/ui — Plugin UI toolkit (apiVersion "1", additive-only).
//
// Two audiences:
//   1. Plugin authors — use `defineMountable`, `usePluginQuery`,
//      `usePluginMutation`, `PluginPage/Section/Card/Skeleton`, the
//      `PluginContext` type.
//   2. The host — uses the types only; the host does NOT import `defineMountable`
//      or the wrappers directly (plugin bundles carry their own React).

export type {
  SlotId,
  SlotMeta,
  SlotMetaMap,
  UIEntry,
  UIDefinition,
} from './slots.ts'

export type {
  PluginContext,
  PluginApiVersion,
  ThemeMode,
  FileEntry,
  ToolInfo,
  QueryOpts,
  QueryResult,
  MutationResult,
  ToastOpts,
  ConfirmOpts,
} from './context-types.ts'

export { PluginPermissionError } from './context-types.ts'

export { defineUI } from './define-ui.ts'

export {
  defineMountable,
} from './mountable.tsx'
export type {
  Mountable,
  PluginMountFn,
  PluginUnmount,
  PluginComponentProps,
} from './mountable.tsx'

export {
  usePluginQuery,
  usePluginMutation,
  type PluginQueryResult,
  type PluginMutationResult,
} from './hooks.ts'

export { PluginPage, PluginSection, PluginCard, PluginSkeleton } from './wrappers.tsx'
