## Phase
Idle — Plan 3, 3.5 complete

## Currently Working On
(idle)

## Relevant Files
- `docs/plans/3-studio-base-implement-report.md` — implementation report Plan 3
- `docs/plans/3.5-policy-implement-report.md` — implementation report Plan 3.5

## Important Context / Temporary Decisions
- `apps/studio/web` sudah import dari `@jiku/ui` untuk semua shadcn + ai-elements components
- `@source "../node_modules/@jiku/ui/src"` di `globals.css` untuk Tailwind v4 content scan
- Server pakai `@hono/node-server` + `ws` npm (bukan Bun.serve) — Node-compatible
- DB commands ada di `apps/studio/server/package.json` dengan `--env-file=../server/.env`
- `ws/chat.ts` masih pakai Anthropic SDK langsung — belum connect ke `@jiku/core` JikuRuntime

## Next Up
- Connect `@jiku/core` JikuRuntime ke `JikuRuntimeManager` (ws/chat.ts saat ini langsung Anthropic SDK)
- DB migrations — jalankan `bun db:generate` + `bun db:migrate` dari server/
- Invite member feature
