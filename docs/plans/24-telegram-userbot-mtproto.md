# Plan 24 — Telegram Userbot via MTProto (mtcute)

> **Goal:** Tambahkan kemampuan ke plugin `jiku.telegram` untuk register **dua connector adapter** dalam satu plugin: existing `Telegram Bot` (Bot API via grammy) + baru `Telegram User Self-Bot` (MTProto via mtcute). Userbot membuka kapabilitas yang Bot API tidak bisa — utamanya `forward_messages` dengan `drop_author=true` (hide sender + preserve custom_emoji animated), full message history access, react sebagai user, join channel programmatically, dll.
>
> **Why now:** Test Plan 27 (forward/copy custom_emoji) mengungkap batasan platform Bot API — bot tidak Premium, jadi `copyMessage` lose custom_emoji animation. MTProto `messages.forwardMessages({drop_author: true})` solve ini natively. Use case scenario marketing channel butuh ini.
>
> **Non-goals:**
> - Tidak menggantikan `jiku.telegram.bot` — keduanya tetap exist, user pilih sesuai kebutuhan.
> - Tidak buat abstraksi "universal Telegram adapter" yang switch protocol behind the scenes — terlalu rapuh + capability beda.
> - Tidak handle MTProto FCM / push notification subtle (di luar scope).

---

## 1. Konteks

### Apa yang Dibawa MTProto + mtcute

[mtcute](https://mtcute.dev/) adalah TypeScript-native MTProto client (alternatif gramjs/telethon di JS ecosystem) dengan first-class Bun support via `@mtcute/bun`. Login pakai phone number, dapat full Telegram client API.

Kapabilitas spesifik yang Bot API tidak punya:

| Kapabilitas | Bot API | MTProto (mtcute) |
|---|---|---|
| Forward + hide sender + preserve custom_emoji | ❌ | ✅ `forwardMessages({forwardSenders: false})` |
| Read full chat history (>100 messages, arbitrary offset) | Limited | ✅ `getHistory()` |
| Join channel/group via invite link | Limited | ✅ |
| Send message as user (no "via bot" badge) | ❌ | ✅ |
| Use Premium custom_emoji from any pack | ❌ | ✅ (kalau user Premium) |
| Read message reactions detail | Limited | ✅ |
| Schedule message | ❌ | ✅ `scheduleDate` |
| Edit own messages tanpa batas waktu | 48 jam | ✅ |
| Account info (contacts, dialogs) | ❌ | ✅ |

Trade-off: userbot adalah **session berbasis akun real**. Telegram bisa banned akun kalau detect automation abuse. Risiko di-tanggung user yang setup.

### Arsitektur Existing Plugin

Plugin `jiku.telegram` saat ini:
- Register 1 connector: `id: 'jiku.telegram'`, name "Telegram"
- Adapter `TelegramAdapter` extends `ConnectorAdapter`
- `onActivate(ctx)` baca `ctx.fields.bot_token`, instantiate grammy `Bot`
- Credential schema: `{ bot_token: string }`

Plan ini mengubah jadi:
- Plugin **tetap satu** (`jiku.telegram`)
- Register **dua connector**:
  - `jiku.telegram.bot` — name "Telegram Bot" — adapter existing (renamed from `TelegramAdapter` → `TelegramBotAdapter`)
  - `jiku.telegram.user` — name "Telegram User (Self-Bot)" — adapter baru `TelegramUserAdapter` pakai mtcute

---

## 2. Credentials Schema per Adapter

### `jiku.telegram.bot` (existing, no change)

```ts
fields: {
  bot_token: { type: 'string', secret: true, required: true, label: 'Bot Token from @BotFather' }
}
```

### `jiku.telegram.user` (baru)

```ts
fields: {
  api_id: { type: 'string', required: true, label: 'API ID from my.telegram.org' },
  api_hash: { type: 'string', secret: true, required: true, label: 'API Hash from my.telegram.org' },
  phone_number: { type: 'string', required: true, label: 'Phone number with country code, e.g. +628123456789' },
  // Filled automatically AFTER successful interactive setup:
  session_string: { type: 'string', secret: true, required: false, label: 'Session (auto-generated)', read_only: true },
  user_id: { type: 'string', required: false, label: 'Logged-in user ID (auto)', read_only: true },
  username: { type: 'string', required: false, label: 'Username (auto)', read_only: true },
  is_premium: { type: 'boolean', required: false, label: 'Premium account', read_only: true },
}
```

Field `session_string` adalah hasil mtcute `client.exportSession()` setelah login sukses. Disimpan encrypted seperti credential lain — ini equivalent "bot_token" untuk session yang akan datang. Tanpa session string, adapter tidak bisa connect.

---

## 3. Setup API — Konsep Baru

**Masalah:** userbot login itu **interactive multi-step**:

1. User submit phone + api_id + api_hash.
2. Server panggil mtcute `sendCode(phone)` → Telegram kirim OTP via SMS/app.
3. User input OTP.
4. Server panggil `signIn(code)` → kalau sukses → done, tapi kalau 2FA enabled → throw "password required".
5. Kalau 2FA, user input password.
6. Server panggil `checkPassword(password)` → done.
7. Server `exportSession()` → save session_string ke credential.

Ini tidak bisa di-handle dengan single POST `/credentials` request. Butuh **session state di server** + **multi-step UI**.

### API Surface Baru di `ConnectorAdapter`

```ts
abstract class ConnectorAdapter {
  // ... existing methods ...

  /**
   * Optional. Adapter declares it needs interactive setup.
   * When present, Studio shows a "Setup" button on the credential
   * form instead of (or in addition to) the standard "Save" button.
   */
  getSetupSpec?(): ConnectorSetupSpec

  /**
   * Optional. Called by the Studio "Setup" UI to drive the interactive flow.
   * Adapter is responsible for managing transient state (in-memory map keyed
   * by setup_session_id). On final step, returns { complete: true, fields: {...} }
   * — Studio merges those fields into the credential and saves.
   */
  runSetupStep?(stepId: string, input: Record<string, unknown>, sessionState: SetupSessionState): Promise<SetupStepResult>
}

interface ConnectorSetupSpec {
  /** Steps the wizard will walk through, in order. UI can render hint per step. */
  steps: Array<{
    id: string                  // e.g. 'request_code', 'verify_code', 'verify_password'
    title: string               // e.g. 'Send OTP'
    description: string
    inputs: Array<{
      name: string
      type: 'string' | 'number' | 'boolean'
      required: boolean
      secret?: boolean          // OTP & password = true → masked input
      label: string
      placeholder?: string
    }>
    /** Optional: indicates this step is conditional (e.g. only if 2FA enabled). */
    conditional?: boolean
  }>
}

interface SetupSessionState {
  session_id: string
  credential_id?: string        // present once draft credential saved
  // Adapter-owned scratch (persisted server-side but not exposed to UI).
  scratch: Record<string, unknown>
}

type SetupStepResult =
  | { ok: true; next_step?: string; ui_message?: string }                // continue
  | { ok: true; complete: true; fields: Record<string, unknown>; ui_message?: string }  // done
  | { ok: false; error: string; hint?: string; retry_step?: string }     // recoverable error
```

### Server-Side Setup Endpoints (Auto-Wired)

Studio auto-mount endpoints standar untuk semua adapter yang implement `getSetupSpec()`:

```
POST   /api/projects/:pid/credentials/:credId/setup/start
        → return { setup_session_id, spec: ConnectorSetupSpec }

POST   /api/projects/:pid/credentials/:credId/setup/:sessionId/step
        body: { step_id: string, input: Record<string, unknown> }
        → SetupStepResult

DELETE /api/projects/:pid/credentials/:credId/setup/:sessionId
        → cancel + cleanup
```

Server-side `SetupSessionStore`:
- In-memory `Map<sessionId, SetupSessionState>` dengan TTL 15 menit.
- Kunci-nya `setup_session_id` (random UUID, returned saat `start`).
- Adapter access via parameter `sessionState`, mutate `scratch` for cross-step state (e.g. menyimpan mtcute client instance, phone_code_hash dari Telegram).

Multi-tenancy: setup session terikat ke `(project_id, credential_id)`. Cuma user dengan permission `credentials:write` di project itu yang boleh akses.

### Plugin UI Slot (Custom Setup Wizard)

Untuk kebanyakan adapter, generic wizard berdasarkan `ConnectorSetupSpec` cukup. Tapi userbot mungkin butuh UI custom (mis. tampilkan QR code untuk login alternatif). Plugin bisa override dengan slot baru:

```
slot_id: 'connector.adapter.setup'
slot_meta: { adapter_id: 'jiku.telegram.user' }
```

Plugin register UI di slot ini. Studio cek dulu apakah ada UI custom; kalau tidak, fallback ke generic wizard yang render dari `getSetupSpec()`.

Untuk MVP: pakai generic wizard saja. Custom UI = future enhancement.

---

## 4. Connector Registration di `setup(ctx)`

Plugin entry sekarang register **dua** connector:

```ts
definePlugin({
  meta: { id: 'jiku.telegram', ... },
  setup(ctx) {
    // Existing
    ctx.connectors.register({
      id: 'jiku.telegram.bot',
      name: 'Telegram Bot',
      description: 'Standard Telegram bot via Bot API. Best for: replying to mentions, sending notifications, simple automation. Limitations: no native forward-with-hidden-sender, no Premium custom_emoji preservation when copying.',
      adapter: () => new TelegramBotAdapter(),
      credentialSchema: { fields: { bot_token: { ... } } },
    })

    // New
    ctx.connectors.register({
      id: 'jiku.telegram.user',
      name: 'Telegram User (Self-Bot)',
      description: 'Telegram via MTProto using a real user account. Best for: forwarding with hidden sender + animated custom_emoji, reading full chat history, joining channels programmatically. Caveat: requires interactive setup (phone OTP + 2FA), and Telegram may flag automation on user accounts — use at your own risk.',
      adapter: () => new TelegramUserAdapter(),
      credentialSchema: { fields: { api_id: { ... }, api_hash: { ... }, phone_number: { ... }, session_string: { ... } } },
      requiresInteractiveSetup: true,   // hint for UI to show "Setup" button
    })
  }
})
```

Field `requiresInteractiveSetup` di `ConnectorRegistration` — kalau true, Studio wajib menjalankan setup wizard sebelum credential dianggap "active".

---

## 5. mtcute Integration di `TelegramUserAdapter`

### Dependencies

```
plugins/jiku.telegram/package.json:
  "dependencies": {
    "grammy": "^1.x",                  // existing
    "@mtcute/bun": "^0.x",             // new — bun-native MTProto client
    "@mtcute/core": "^0.x",            // peer
    "telegramify-markdown": "^x"       // existing
  }
```

### Setup Flow Implementation

```ts
class TelegramUserAdapter extends ConnectorAdapter {
  // In-memory session for setup wizard. Keyed by setup_session_id.
  private setupClients = new Map<string, TelegramClient>()

  override getSetupSpec(): ConnectorSetupSpec {
    return {
      steps: [
        {
          id: 'request_code',
          title: 'Send verification code',
          description: 'Telegram will send a one-time code to your phone via SMS or the Telegram app.',
          inputs: [],   // no input — uses fields already saved on draft credential
        },
        {
          id: 'verify_code',
          title: 'Enter verification code',
          description: 'Enter the 5-digit code Telegram sent.',
          inputs: [
            { name: 'code', type: 'string', required: true, secret: false, label: 'OTP code', placeholder: '12345' },
          ],
        },
        {
          id: 'verify_password',
          title: 'Enter 2FA password',
          description: 'Your account has two-factor authentication enabled.',
          conditional: true,
          inputs: [
            { name: 'password', type: 'string', required: true, secret: true, label: '2FA password' },
          ],
        },
      ],
    }
  }

  override async runSetupStep(stepId, input, state): Promise<SetupStepResult> {
    const cred = await getCredentialFields(state.credential_id!)   // helper — read api_id, api_hash, phone

    if (stepId === 'request_code') {
      const { TelegramClient } = await import('@mtcute/bun')
      const client = new TelegramClient({ apiId: Number(cred.api_id), apiHash: cred.api_hash })
      await client.connect()
      try {
        const sentCode = await client.sendCode({ phone: cred.phone_number })
        state.scratch.phone_code_hash = sentCode.phoneCodeHash
        this.setupClients.set(state.session_id, client)
        return { ok: true, next_step: 'verify_code', ui_message: 'Code sent. Check your Telegram app or SMS.' }
      } catch (err) {
        await client.disconnect()
        return { ok: false, error: String(err), hint: 'Verify api_id, api_hash, and phone_number are correct.' }
      }
    }

    if (stepId === 'verify_code') {
      const client = this.setupClients.get(state.session_id)
      if (!client) return { ok: false, error: 'Setup session expired. Restart from step 1.' }
      try {
        await client.signIn({
          phone: cred.phone_number,
          phoneCodeHash: state.scratch.phone_code_hash as string,
          phoneCode: input.code as string,
        })
      } catch (err) {
        const msg = String(err)
        if (msg.includes('SESSION_PASSWORD_NEEDED')) {
          return { ok: true, next_step: 'verify_password', ui_message: '2FA enabled. Enter your password.' }
        }
        if (msg.includes('PHONE_CODE_INVALID')) {
          return { ok: false, error: msg, hint: 'OTP code incorrect. Check the code and try again.', retry_step: 'verify_code' }
        }
        return { ok: false, error: msg }
      }
      return this.finalizeLogin(client, state)
    }

    if (stepId === 'verify_password') {
      const client = this.setupClients.get(state.session_id)
      if (!client) return { ok: false, error: 'Setup session expired.' }
      try {
        await client.checkPassword(input.password as string)
      } catch (err) {
        return { ok: false, error: String(err), hint: 'Wrong 2FA password.', retry_step: 'verify_password' }
      }
      return this.finalizeLogin(client, state)
    }

    return { ok: false, error: `Unknown step: ${stepId}` }
  }

  private async finalizeLogin(client, state): Promise<SetupStepResult> {
    const me = await client.getMe()
    const session = await client.exportSession()
    await client.disconnect()
    this.setupClients.delete(state.session_id)
    return {
      ok: true,
      complete: true,
      fields: {
        session_string: session,
        user_id: String(me.id),
        username: me.username ?? '',
        is_premium: me.isPremium ?? false,
      },
      ui_message: `Logged in as @${me.username ?? me.id} (${me.isPremium ? 'Premium' : 'Free'}). Setup complete.`,
    }
  }

  override async onActivate(ctx) {
    const session = ctx.fields.session_string
    if (!session) throw new Error('Session not configured. Run interactive setup first.')
    const { TelegramClient } = await import('@mtcute/bun')
    this.client = new TelegramClient({ apiId: Number(ctx.fields.api_id), apiHash: ctx.fields.api_hash, sessionString: session })
    await this.client.connect()
    // ... wire up event handlers ...
  }
}
```

---

## 6. Capability Surface Difference

Action registration di `TelegramUserAdapter` mostly **mirror** `TelegramBotAdapter`, tapi ada actions exclusive:

### Userbot-only actions

| Action | Why MTProto-only |
|---|---|
| `forward_message_drop_author` | The flagship — forward + hide sender + preserve custom_emoji. |
| `get_chat_history` | Read N messages back from arbitrary offset, full text + entities. |
| `join_chat` | Join via invite link or username. |
| `leave_chat` | |
| `get_dialogs` | List all chats account is in. |
| `get_full_user` | Detailed user profile. |
| `schedule_message` | Send at a future timestamp. |
| `set_typing` | Show "typing..." indicator (longer than bot can). |

### Actions yang shared (signature sama, implementasi beda backend)

| Action | Bot adapter | User adapter |
|---|---|---|
| `send_message` | grammy sendMessage | mtcute sendText |
| `forward_message` | forwardMessage / copyMessage | forwardMessages with `forwardSenders` flag |
| `send_photo` | sendPhoto | sendMedia(InputMediaUploadedPhoto) |
| `delete_message` | deleteMessage | deleteMessages |

### Actions yang Bot-only (tidak make sense untuk userbot)

| Action | Why |
|---|---|
| `set_chat_description` | Userbot bisa via different API tapi jarang use case. |
| `ban_member` | Same. |
| `pin_message` | Same. |

Convention: action ID **identik** kalau semantik sama. Adapter berbeda implement-nya. Agent panggil `connector_run_action('forward_message', {...})` — karena dia dapat `connector_id` spesifik (bot vs user), routing-nya jelas.

### `forward_message` di User Adapter

Default `hide_sender: true` di user adapter benar-benar **bekerja** (pakai `forwardMessages({forwardSenders: false})`) — custom_emoji preserve karena message tetap atribusi ke original author (tapi UI Telegram tidak render header "Forwarded from"). Schema description di-update untuk eksplisit jelaskan: "user adapter — hide_sender works correctly with custom_emoji preservation, unlike bot adapter".

---

## 7. Implementation Phases

### Phase 1 — Foundation (Setup API)
1. Tambahkan `getSetupSpec` + `runSetupStep` ke abstract `ConnectorAdapter`.
2. `ConnectorSetupSpec` + `SetupSessionState` + `SetupStepResult` types di `@jiku/kit`.
3. Server: 3 endpoint setup (`/setup/start`, `/setup/:sessionId/step`, DELETE).
4. Server: in-memory `SetupSessionStore` dengan TTL 15 min, audit `credential.setup_started`/`credential.setup_completed`/`credential.setup_failed`.
5. UI: generic wizard component yang konsumsi `ConnectorSetupSpec` (multi-step form, masked input untuk secret, error banner dengan hint).
6. Field `requiresInteractiveSetup` di `ConnectorRegistration` + UI: tombol "Setup" muncul kalau true.

### Phase 2 — Plugin Restructure
7. Rename existing `TelegramAdapter` → `TelegramBotAdapter`, connector_id `jiku.telegram` → `jiku.telegram.bot`.
8. **Migration script:** existing `connector` rows yang `plugin_id='jiku.telegram'` → set `connector_id='jiku.telegram.bot'`. Backward compat: server alias `jiku.telegram` → `jiku.telegram.bot` selama 1 release cycle.
9. Plugin entry `setup(ctx)` register dua connector.

### Phase 3 — User Adapter MVP
10. Add `@mtcute/bun` dependency.
11. Implement `TelegramUserAdapter` skeleton: credential schema, `getSetupSpec()`, `runSetupStep()` (request_code → verify_code → verify_password).
12. `onActivate` baca session_string, instantiate mtcute client.
13. Implement subset action minimal: `send_message`, `forward_message` (drop_author), `get_chat_history`.
14. Inbound event flow: subscribe mtcute `client.on('new_message')`, normalize ke `ConnectorEvent` shape yang sama dengan bot adapter.

### Phase 4 — Action Parity + Polish
15. Implement remaining shared actions di user adapter (`send_photo`, `delete_message`, `edit_message`).
16. Add userbot-exclusive actions: `join_chat`, `leave_chat`, `get_dialogs`, `schedule_message`.
17. Schema description untuk `forward_message` di user adapter: jelaskan ini path optimal untuk hide_sender + custom_emoji preservation.
18. Param schema reuse mekanisme Plan 27.

### Phase 5 — Hardening
19. Session refresh: kalau mtcute return `AUTH_KEY_UNREGISTERED` (session expired), mark credential `setup_required=true`, surface ke UI sebagai banner "Session expired, re-setup needed".
20. **Queue management implementation (§8b)**: per-chat FIFO queue dengan minimum gap 1000ms, global session quota 20/menit, per-action cooldown untuk join/leave/forward-drop-author, new-chat min gap 5000ms. Tidak ada mode disable.
21. `FLOOD_WAIT_X` handler: parse `wait_seconds`, pause queue scope (chat-level atau session-level), audit `userbot.flood_wait`, return structured error ke agent dengan hint backoff.
22. `PEER_FLOOD` detection: mark credential `health: 'spam_restricted'`, stop auto-send, UI banner merah, audit critical.
23. Queue observability: tool `connector_get_queue_status` + audit field `queued_at/executed_at/delay_ms_applied` per outbound.
24. Audit events lengkap: `userbot.session_expired`, `userbot.flood_wait`, `userbot.peer_flood_detected`, `userbot.queue_delayed`, `userbot.spam_warning`.
25. Doc warning di UI setup: "Using a personal Telegram account for automation may result in account restrictions or ban. Use a dedicated account, not your primary one. Rate limits are enforced server-side and cannot be disabled."

---

## 8. UI Flow Mock (Setup Wizard Generic)

```
┌─────────────────────────────────────────────────┐
│  Telegram User (Self-Bot) — Setup Wizard        │
├─────────────────────────────────────────────────┤
│  Step 1 of 3: Send verification code            │
│                                                 │
│  Telegram will send a one-time code to your     │
│  phone (+62812****6789) via SMS or the          │
│  Telegram app.                                  │
│                                                 │
│  [ Cancel ]                  [ Send Code → ]    │
└─────────────────────────────────────────────────┘

(after click)
┌─────────────────────────────────────────────────┐
│  Step 2 of 3: Enter verification code           │
│                                                 │
│  Code sent. Check your Telegram app or SMS.     │
│                                                 │
│  OTP code: [ _ _ _ _ _ ]                        │
│                                                 │
│  [ Back ]                    [ Verify → ]       │
└─────────────────────────────────────────────────┘

(if 2FA error caught)
┌─────────────────────────────────────────────────┐
│  Step 3 of 3: Enter 2FA password                │
│                                                 │
│  ⓘ 2FA enabled. Enter your password.            │
│                                                 │
│  Password: [ ●●●●●●●●●●● ]                       │
│                                                 │
│  [ Back ]                    [ Verify → ]       │
└─────────────────────────────────────────────────┘

(success)
┌─────────────────────────────────────────────────┐
│  ✅ Setup Complete                              │
│                                                 │
│  Logged in as @viandwi24 (Premium).             │
│  Session saved to credential.                   │
│                                                 │
│                              [ Done ]           │
└─────────────────────────────────────────────────┘
```

---

## 8b. Queue Management & Rate Limiting (MANDATORY)

**Prinsip non-negotiable:** userbot **tidak boleh** blast API request tanpa throttling. Telegram sangat sensitif terhadap pola spam dari user account — threshold ban jauh lebih ketat daripada bot account. Semua outbound Telegram API call (send, forward, copy, edit, delete, react, join, leave, dsb) **wajib** melewati queue. Semua inbound polling juga dibatasi cadence-nya.

### Policy Queue yang Diterapkan

**Per-chat queue (sudah ada di bot adapter via `enqueueForChat`).** Di user adapter:
- Queue FIFO per `chat_id` — satu outbound operation tamat dulu sebelum yang berikutnya start.
- Minimum inter-message delay: **1000ms** per chat (bandingkan bot adapter 300ms). Alasan: Telegram userbot heuristik spam menghitung pesan per detik per chat.
- Burst protection: max 3 outbound dalam 10 detik per chat, lebih dari itu auto-queue dengan delay tambahan.

**Global queue per-session (khusus userbot).**
- Max 20 outbound per menit across all chats per session. Di atas itu auto-delay.
- Kenapa: mtcute global flood wait kalau total API call terlalu sering, walaupun spread ke banyak chat.

**Per-action-type cooldown (khusus action "sensitive").**
- `join_chat` / `leave_chat` — max 10 per jam per session. Melebihi ini = red flag spam behavior.
- `send_message` to new chat (chat yang belum pernah di-interact sebelumnya di session ini) — throttle ekstra: minimum 5 detik gap antar new-chat first-send. Ini simulasi behavior manusia.
- `forward_message` (drop_author) — minimum 2000ms gap per source chat. Mencegah "scraping bot" pattern yang gampang banned.

### Respons terhadap Rate-Limit dari Telegram

**`FLOOD_WAIT_X` (X = detik):**
- Adapter **wajib** respect nilai X. Tidak ada retry sebelum X detik habis.
- Queue di-pause untuk chat yang kena (kalau `FLOOD_WAIT` chat-scoped) atau untuk seluruh session (kalau global).
- Audit event `userbot.flood_wait { seconds, scope: 'chat'|'session', source_action }`.
- Return ke agent: `{ success: false, error: 'FLOOD_WAIT', wait_seconds: X, hint: 'Telegram rate-limited this session. Retry after X seconds. Throttle your action frequency.' }`
- Agent diharapkan backoff, bukan retry immediately.

**`PEER_FLOOD` (Telegram permanent spam flag):**
- Session masuk state "spam restricted" — cuma bisa kirim ke chat yang sudah existing, tidak bisa start percakapan baru.
- Adapter mark credential `health: 'spam_restricted'`, surface ke UI sebagai banner merah.
- Audit `userbot.peer_flood_detected` — critical event, notify admin.
- Adapter **berhenti** auto-send kecuali agent eksplisit acknowledge restriction.

**`AUTH_KEY_DUPLICATED`:**
- Sesi di-invalidate dari sisi Telegram (biasanya karena user login ulang di device lain, atau Telegram anggap session compromised).
- Mark credential `setup_required: true`, surface "session expired, re-setup needed".

### Config yang Dibaca dari Credential / Project

Queue policy default di-hardcode di adapter, tapi bisa di-override per-credential untuk advanced user yang paham risiko:

```ts
fields: {
  // ... existing ...
  queue_policy: {
    type: 'object',
    required: false,
    default: {
      min_gap_per_chat_ms: 1000,
      max_per_minute_global: 20,
      new_chat_min_gap_ms: 5000,
      forward_drop_author_min_gap_ms: 2000,
    },
    label: 'Rate limit policy (advanced — reduce ban risk)',
    hint: 'Lower values = faster but higher ban risk. Raise these for sensitive accounts.',
  }
}
```

**Tidak ada mode "disable queue".** Hard constraint — agent/user tidak boleh bypass. Alasan: kegagalan satu session bisa banned akun selama berhari-hari, recovery mahal.

### Queue Observability

- Setiap item di queue tercatat di audit log dengan `queued_at`, `executed_at`, `delay_ms_applied`.
- Agent bisa query via tool baru `connector_get_queue_status(connector_id)` → return `{ pending: N, rate_used_percent, estimated_delay_next }`. Agent bisa decide "terlalu penuh, drop non-critical task".
- UI Studio: `/channels/:id` tampilkan indicator queue health (green/yellow/red).

### Spam Prevention di Layer Agent (Complementary)

Queue di adapter = last line of defense. Di layer agent:
- `outbound_approval_mode` (Plan future) tetap relevan untuk konten sensitif.
- Agent logic sendiri harus sadar jangan spam — misalnya agent loop yang broadcast ke 100 channel dalam 1 menit adalah red flag behavior, bahkan kalau queue adapter slow-down.
- Binding rate limit per-scope (Plan future §9b nice-to-have) → additional guard.

---

## 9. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Telegram banned akun user karena automation | UI warning prominent. Saran user pakai dedicated number, bukan primary. |
| Session string bocor → akun di-takeover | Disimpan encrypted (sama seperti bot_token existing). Ditampilkan di UI sebagai `••••••••` only. Audit event saat session di-export. |
| `FLOOD_WAIT_X` dari Telegram | **Pencegahan primer: queue management di §8b (per-chat queue, global session quota, per-action cooldown).** Response saat sudah kena: adapter respect `wait_seconds`, pause queue scope terkait, return structured error ke agent. |
| `PEER_FLOOD` / akun tagged spam | Throttle ketat di §8b. Saat tetap terjadi: credential mark `health: 'spam_restricted'`, audit critical, stop auto-send. |
| Akun user di-banned karena volume / pattern spam | Queue policy mandatory di §8b TIDAK bisa di-bypass. Minimum delay, burst protection, new-chat cooldown. |
| User input OTP salah berulang → akun lock | Limit 3 retry per setup_session_id, lalu force restart dari step 1. |
| Setup session in-memory hilang saat server restart | Acceptable — user tinggal restart wizard. Session TTL 15 min. |
| `@mtcute/bun` belum 1.0 stable | Pin version exact, monitor breaking changes. Fallback `@mtcute/node` kalau `@mtcute/bun` bermasalah. |
| Multi-tenant: dua user di project yang sama setup userbot bareng | Setup session keyed by `(project_id, credential_id, setup_session_id)`. Credential tetap isolated per row. |
| Bot adapter user existing break karena rename `jiku.telegram` → `jiku.telegram.bot` | Server-side alias selama 1 release cycle. Migration script update existing rows. UI: deprecation note. |

---

## 10. Out of Scope (Future)

- Custom UI slot untuk setup (di luar generic wizard) — Phase 6.
- QR code login (mtcute support `client.qrLogin()`) — alternative ke OTP. Bagus untuk UX, tapi MVP cukup OTP.
- Multi-account user dalam 1 credential — saat ini 1 credential = 1 session. Future: multi-session pool.
- Telegram Premium custom_emoji **upload** dari userbot — agent bisa upload sticker pack. Niche use case.
- Voice call / video call automation — definitely out of scope.

---

## 11. Acceptance Criteria

- [ ] Plugin `jiku.telegram` register 2 connector di `connector_list`: `jiku.telegram.bot` + `jiku.telegram.user`.
- [ ] User pilih `Telegram User (Self-Bot)` saat create credential → form muncul dengan field api_id, api_hash, phone_number.
- [ ] Setelah save credential draft, tombol "Setup" muncul → klik → wizard 2-3 step jalan (request_code → verify_code → optional verify_password).
- [ ] Setup gagal (OTP salah, 2FA salah, phone invalid) → error dengan hint actionable, user bisa retry.
- [ ] Setup sukses → session_string + user_id + username + is_premium ter-save di credential.
- [ ] Adapter `onActivate` baca session, mtcute client connect, inbound event flow.
- [ ] Action `forward_message` di user adapter dengan `hide_sender: true` benar-benar **menghilangkan header "Forwarded from"** DAN **preserve custom_emoji animated** (verified manual test dengan pesan Premium custom_emoji).
- [ ] **Queue management aktif (§8b):** per-chat min gap 1000ms verified via timing test, global session quota 20/menit verified, FLOOD_WAIT_X handler pause scope dengan benar, PEER_FLOOD mark credential `spam_restricted`. Tidak ada code path yang bypass queue.
- [ ] Tool `connector_get_queue_status` return real-time pending count + rate utilization.
- [ ] Audit event lengkap: `credential.setup_started`, `credential.setup_completed`, `credential.setup_failed`, `userbot.session_expired`, `userbot.flood_wait`, `userbot.peer_flood_detected`, `userbot.queue_delayed`.
- [ ] Migration: existing `jiku.telegram` connector di project → tetap berfungsi via alias, tampil di UI sebagai `jiku.telegram.bot`.
- [ ] Bot adapter existing: zero regression — semua test Plan 27 tetap pass.

---

## 12. Open Questions

1. **Adapter sub-id format.** `jiku.telegram.bot` vs `jiku.telegram:bot` — pakai dot atau colon? Konsistensi dengan existing plugin tool prefix (`jiku.telegram:fetch_media`). Saya saran tetap **dot** untuk connector_id, **colon** untuk tool prefix (sudah ada konvensi).

2. **Generic wizard di mana hidup?** `apps/studio/web/components/connectors/setup-wizard.tsx` (per-feature) atau `packages/ui/src/wizards/connector-setup.tsx` (shared). Saya saran web-app dulu (lebih cepat iterate), promote ke package kalau ada plugin lain butuh.

3. **Backward compat alias durasi.** 1 release cycle = berapa minggu di Jiku? Cek dengan changelog cadence.

4. **Userbot conflict dengan bot di chat sama?** Kalau user setup userbot di akun yang juga ngundang bot ke grup yang sama, bisa double-handle inbound event. Solusi: binding rule prioritas / dedup di event-router. Catat sebagai follow-up.

---

## 13. References

- mtcute docs: https://mtcute.dev/guide/
- mtcute Bun runtime: https://www.npmjs.com/package/@mtcute/bun
- MTProto API method `messages.forwardMessages` flag `forwardSenders`: https://core.telegram.org/method/messages.forwardMessages
- Existing plugin: `plugins/jiku.telegram/src/index.ts`
- Plan 27 (custom params + entities): docs/scenarios/1-manage-a-channel-with-agent.md §9.D
- Plugin HTTP route prefix: `apps/studio/server/src/plugins/ui/http-registry.ts:3` — auto-mount di `/api/plugins/<id>/api/*`
