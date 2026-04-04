## Phase
Plan 4 — Credentials + Chat via JikuRuntime (complete)

## Currently Working On
(idle)

## Relevant Files
- `apps/studio/server/src/runtime/manager.ts` — JikuRuntimeManager holds one JikuRuntime per project
- `apps/studio/server/src/runtime/storage.ts` — StudioStorageAdapter implements full JikuStorageAdapter
- `apps/studio/server/src/routes/chat.ts` — POST /api/conversations/:id/chat via runtimeManager.run()
- `apps/studio/server/src/credentials/service.ts` — buildProvider() + resolveAgentModel()
- `apps/studio/web/components/agent/chat/chat-interface.tsx` — useChat from @ai-sdk/react, shows error state

## Important Context / Temporary Decisions
- **project = runtime** — di studio, satu project = satu JikuRuntime (mengikuti terminologi @jiku/core)
- Chat lewat `runtimeManager.run(projectId, params)` → `JikuRuntime.run()` → `AgentRunner` → `streamText()`
- Provider di runtime adalah "dynamic provider" — `buildProvider()` dipanggil per-request, model di-cache sementara di `modelCache` Map selama stream berlangsung
- `model_id` yang dikirim ke JikuRuntime adalah cache key unik (`agentId:timestamp:random`), bukan model id sungguhan
- Stream di-wrap untuk cleanup model cache setelah stream selesai
- `StudioStorageAdapter.createConversation()` butuh `user_id` di data — di-pass via `(data as Record)[user_id]` karena tidak ada di `@jiku/types Conversation`
- Message `content` di DB adalah jsonb — bisa legacy string atau `MessageContent[]` array. Storage adapter handle keduanya.
- Plugin KV store adalah in-memory Map (belum ada DB table untuk plugin storage)
- Error dari server (400) ditampilkan di ChatInterface sebagai error bubble merah
- `NEXT_PUBLIC_WS_URL` env var tidak diperlukan lagi (WebSocket sudah dihapus)

## Next Up
- Tambah plugin system ke runtime (saat ini PluginLoader kosong)
- Invite member feature
- Plugin KV store ke DB (optional)
