# Action Request Center (Plan 25)

Unified human-in-the-loop gate. One DB-backed entity (`action_requests`) powers three
use-cases that previously would have been three subsystems:

1. **Outbound approval** — connector messages held until an operator approves.
2. **Agent-initiated request** — agent asks for input/choice/confirmation mid-run.
3. **Task checkpoint** — long-running tasks pause for risky-action approval.

## Architecture

```
agent/connector/admin
        │ (creates)
        ▼
   action_requests row  ◀── operator views/responds via /actions UI
        │
        │ (final state transition)
        ▼
   destination handler  ──── side-effect (send message, spawn task, resume task)
        │
        ▼
   pubsub bus  ──── SSE UI
```

Agent flow is **always detached**: `action_request_create` returns immediately
with `{ action_request_id, status: 'pending' }`. The operator decision flows to
its destination handler independently — there is no `wait` tool. If the agent
needs the decision injected back into its conversation, use the `task_resume`
destination so the runner re-invokes after the operator responds.

### Tables

`action_requests` — one row per request. Polymorphic by `type` (UI shape) and `source_type` /
`destination_type` (where the decision flows). `spec` JSON holds type-specific UI config;
`source_ref` / `destination_ref` are typed unions; `status` is a strict state machine
(`pending` → `approved` | `rejected` | `answered` | `dropped` | `expired` | `failed`).

`action_request_events` — append-only audit trail per AR (`created`, `responded`,
`dropped`, `expired`, `executed`, `execution_failed`).

State transitions are atomic via a `WHERE status='pending'` predicate in the UPDATE; race
between operator response and expiry sweep is impossible.

### Types

| Type | UI | Response shape |
|---|---|---|
| `boolean` | Two buttons (Approve/Reject by default) | `{ value: bool, label: string }` |
| `choice`  | n buttons | `{ value: string, label: string }` |
| `input`   | Single input (text/textarea/password/number/url/email) | `{ value: string }` |
| `form`    | Multi-field form | `{ values: Record<string, unknown> }` |

### Destinations

| destination_type | Supported AR types | Effect on final state |
|---|---|---|
| `outbound_approval` | **boolean only** (validated at create) | `approved` → adapter.sendMessage; `rejected` → silent drop |
| `task` | all | spawn NEW task with response injected via `prompt_template` |
| `task_resume` | all | inject decision into existing task conversation, re-invoke runner |
| *(null)* | all | no side-effect; pure sync-wait pattern |

Handlers are registered at boot from `apps/studio/server/src/index.ts` via
`registerOutboundApprovalHandler()` and `registerTaskDestinationHandlers()`. New
destinations plug in with `registerDestinationHandler(type, handler)`.

## Agent tools

- `action_request_create(...)` — creates AR, returns `{ action_request_id, status: 'pending' }`. Non-blocking, fire-and-forget.
- `action_request_list({ status?, agent_only?, limit })` — read-only, for self-monitoring.

There is intentionally **no wait tool** — the agent should always create-and-move-on.
If the operator decision needs to flow back into the agent's conversation, choose a
destination (`outbound_approval` / `task_resume`) — the destination handler runs
independently when the operator responds.

Per-agent rate limit: max 10 concurrent `pending` requests. Beyond that, `create` returns
`{ error, code: 'too_many_pending' }`.

## Outbound approval flow

Configured per **connector** (project-wide for that connector instance) on the channel
detail page. Modes:

- `none` (default) — `connector_send` executes immediately.
- `always` — every `connector_send` is held as a `boolean` AR with `destination_type='outbound_approval'`.
- `tagged` — only sends with `params.require_approval=true` are held.

Bypass for emergency system messages: agent passes `params.skip_approval=true`. Both
`skip_approval` and `require_approval` are stripped from the persisted payload before
the destination handler re-resolves the adapter and calls `sendMessage`.

Agent that called `connector_send` receives `{ success: true, queued: true,
action_request_id, status: 'pending', hint }` and is expected to MOVE ON — the
operator decision flows into the destination handler (which calls
`adapter.sendMessage` on approve, drops on reject) without any agent involvement.

## Task checkpoint

Always **detached-resume**: agent calls `action_request_create({ destination: { type:
'task_resume', ref: { task_id, resume_token } } })` and exits the task. When AR
resolves, the `task_resume` destination handler injects a synthetic `[Operator
decision]` message into the conversation and re-invokes `runTaskConversation` against
the existing conversation_id. Agent picks up where it left off with the decision in
message history.

Resume-token validation: the handler reads `conversations.metadata.action_request_resume_tokens[token]`
and refuses resume if it's bound to a different AR. Agents seeding a token at create
time should also write it to that map (currently best-effort — token not enforced if
metadata empty).

## UI

Route: `/studio/companies/:company/projects/:project/actions`. Three tabs: Active /
Recent / Dropped. Sidebar badge shows pending count (project-scoped, hidden from users
without `action_requests:read`). SSE stream at
`/api/projects/:pid/action-requests/stream` invalidates the React Query cache on any
update; per-AR latency from server transition → UI refresh is sub-second on LAN.

## Permissions

- `action_requests:read` — list + detail.
- `action_requests:respond` — submit decisions / drop. Non-managers see read-only.
- `action_requests:write` — create AR via `POST /api/projects/:pid/action-requests`
  (admin/manual flow; agent tool calls bypass via system identity).

Backfill: existing Owner/Admin/Manager roles get all three; Member gets `:read` only.

## Realtime

Single-process EventEmitter (`apps/studio/server/src/action-requests/pubsub.ts`),
matching the existing in-process pattern used by connector SSE. Channel:
`project:{pid}:ar` (project-scoped, used by SSE hub). Multi-process scale-out
would require swapping to Redis pub/sub — contained behind this module's small API.

## Expiry

Background `setInterval` sweep every 30s scans `pending` rows with `expires_at < NOW()`,
flips them to `expired`, writes audit + event, publishes pubsub. See bootstrap in
`apps/studio/server/src/index.ts`.

## Files

- Migration: `apps/studio/db/src/migrations/0035_plan25_action_requests.sql` (tables + permission backfill), `0036_plan25_outbound_approval.sql` (connectors column).
- Schema: `apps/studio/db/src/schema/action_requests.ts`, additions to `connectors.ts`.
- Queries: `apps/studio/db/src/queries/action_requests.ts`.
- Service: `apps/studio/server/src/action-requests/{service,pubsub,sse-hub,destinations,destination-outbound,destination-task,tools}.ts`.
- Routes: `apps/studio/server/src/routes/action-requests.ts`.
- Interceptor: `apps/studio/server/src/connectors/tools.ts` (`connector_send` execute).
- UI: `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/actions/page.tsx`, sidebar item in `components/sidebar/project-sidebar.tsx`, outbound-approval section in `channels/[connector]/page.tsx`.
- Types: `packages/types/src/index.ts` (ActionRequest types + permissions + role presets).

## Known limitations

- **In-process pubsub** — works for single-process Studio only. Multi-process scale-out
  needs Redis swap.
- **Resume token enforcement** is loose: handler validates only when metadata map exists.
  Future hardening: tool-side `action_request_create` writes token into conversation
  metadata atomically.
- **No per-binding outbound_approval override** — config is connector-level. Plan 25
  documents binding-level intent; pragmatic choice was connector-level for shippability.
- **No bulk approve UI** — Phase 6 polish item not shipped. Drop is single-click per AR.
- **No expiry soft-notification** — Phase 6 polish item not shipped (needs push/email
  infra not yet present).
