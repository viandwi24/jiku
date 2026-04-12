# Rate Limiting (Plan 18)

## What it does

Prevents abuse and accidental DoS by rate-limiting Studio's HTTP API. Five policies layered by risk: global baseline, chat (LLM spend), auth (brute force), credential ops, upload.

## Policies

Defined in `apps/studio/server/src/middleware/rate-limit.ts`:

| Name                  | Window  | Max      | Key                  | Applied to |
|-----------------------|---------|----------|----------------------|------------|
| `globalRateLimit`     | 60s     | 300      | user_id → IP         | all `/api` |
| `chatRateLimit`       | 60s     | 20       | user_id → IP         | `POST /conversations/:id/chat` |
| `authRateLimit`       | 15 min  | 10       | IP only              | `/api/auth/login`, `/api/auth/register` — NOT `/me` |
| `credentialRateLimit` | 60s     | 30       | user_id → IP         | whole credentials router |
| `uploadRateLimit`     | 60s     | 10       | user_id → IP         | `/projects/:pid/files/upload`, `/projects/:pid/attachments/upload` |

Standard `RateLimit-*` headers are enabled (`draft-7`); 429 responses include a `retry_after` seconds field.

## Gotchas

- `keyGenerator` reads `res.locals['user_id']` — NOT `req.user`. Auth middleware attaches identity to `res.locals`.
- `authRateLimit` deliberately uses IP only so an unauthenticated attacker cannot bypass by rotating failed login attempts across fake user IDs.
- `authRateLimit` is **NOT** applied to `/me` (profile fetch) because the frontend polls it; rate-limiting /me would break normal app usage.

## How to add a new limit

1. Add a new `rateLimit({...})` export to `middleware/rate-limit.ts`.
2. Apply per-route (`router.post(path, newLimit, handler)`) or per-router (`router.use(newLimit)`) as appropriate.

## Deferred

Per-project / per-plugin configurable limits. Current config is global code-defined — acceptable for MVP, revisit when multi-tenant usage patterns demand it.

## Related files

- `apps/studio/server/src/middleware/rate-limit.ts`
- `apps/studio/server/src/index.ts` (global application)
- Route files listed in the table above.
