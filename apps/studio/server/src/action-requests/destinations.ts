/**
 * Plan 25 — Destination executor registry.
 *
 * Each destination_type has a registered handler invoked when an AR transitions
 * to a final non-dropped state. Phase 1 ships the registry + a no-op for `null`
 * destinations (sync-wait pattern). Phase 4 registers `outbound_approval`.
 * Phase 5 registers `task` and `task_resume`.
 *
 * Handlers may throw; the service catches and transitions the AR to `failed`.
 */
import type { ActionRequest, ActionRequestDestinationType } from '@jiku/types'

export interface DestinationExecutionContext {
  /** The AR row (already in its final non-dropped state, response populated). */
  action_request: ActionRequest
}

export type DestinationHandler = (ctx: DestinationExecutionContext) => Promise<void>

const handlers = new Map<ActionRequestDestinationType, DestinationHandler>()

export function registerDestinationHandler(type: ActionRequestDestinationType, handler: DestinationHandler): void {
  handlers.set(type, handler)
}

export function getDestinationHandler(type: ActionRequestDestinationType): DestinationHandler | null {
  return handlers.get(type) ?? null
}

/** Validators run at AR-create time. Phase 1 enforces outbound_approval = boolean only. */
export function validateDestinationCompatibility(
  destinationType: ActionRequestDestinationType | null,
  arType: string,
): { ok: true } | { ok: false; error: string } {
  if (destinationType === 'outbound_approval' && arType !== 'boolean') {
    return { ok: false, error: 'outbound_approval destination only supports type=boolean' }
  }
  return { ok: true }
}
