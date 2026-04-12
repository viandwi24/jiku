// Plan 17 — React hooks for plugin components.
// Implemented with plain useState/useEffect so they work with the plugin's
// own bundled React (no dependency on the host's TanStack Query instance).

import { useState, useEffect, useRef, useCallback } from 'react'
import type { PluginContext } from './context-types.ts'

export interface PluginQueryResult<T> {
  data: T | undefined
  error: Error | null
  isLoading: boolean
  refetch: () => Promise<void>
}

/** Reactive wrapper around `ctx.api.query(op, input)`. */
export function usePluginQuery<T = unknown>(
  ctx: PluginContext,
  op: string,
  input?: unknown,
  deps: unknown[] = [],
): PluginQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const reqId = useRef(0)

  const refetch = useCallback(async () => {
    const id = ++reqId.current
    setIsLoading(true)
    setError(null)
    try {
      const r = await ctx.api.query<T>(op, input)
      if (reqId.current === id) setData(r)
    } catch (e) {
      if (reqId.current === id) setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      if (reqId.current === id) setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, op, JSON.stringify(input)])

  useEffect(() => {
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch, ...deps])

  return { data, error, isLoading, refetch }
}

export interface PluginMutationResult<T, V> {
  data: T | undefined
  error: Error | null
  isPending: boolean
  mutate: (input: V) => Promise<T>
  reset: () => void
}

export function usePluginMutation<T = unknown, V = unknown>(
  ctx: PluginContext,
  op: string,
): PluginMutationResult<T, V> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | null>(null)
  const [isPending, setPending] = useState(false)

  const mutate = useCallback(async (input: V): Promise<T> => {
    setPending(true)
    setError(null)
    try {
      const r = await ctx.api.mutate<T>(op, input)
      setData(r)
      return r
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      setError(err)
      throw err
    } finally {
      setPending(false)
    }
  }, [ctx, op])

  const reset = useCallback(() => {
    setData(undefined)
    setError(null)
    setPending(false)
  }, [])

  return { data, error, isPending, mutate, reset }
}
