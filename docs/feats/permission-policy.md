# Feature: Permission & Policy System

## What it does

Sistem permission berbasis rules yang memungkinkan kontrol akses fine-grained ke agent dan tool. Rules adalah data murni — bisa di-load dari DB, file, atau memory, dan diupdate tanpa restart.

## Public API

```ts
import type { PolicyRule, CallerContext } from '@jiku/types'

// Define rules
const rules: PolicyRule[] = [
  {
    resource_type: 'tool',        // 'tool' | 'agent'
    resource_id: 'jiku.social:delete_post',
    subject_type: 'role',         // 'role' | 'permission'
    subject: 'admin',
    effect: 'allow',              // 'allow' | 'deny'
    priority: 0,                  // optional, higher = evaluated first
  },
]

// Caller membawa identitas
const caller: CallerContext = {
  user_id: 'user-123',
  roles: ['admin', 'member'],
  permissions: ['jiku.social:post:write'],
  user_data: { name: 'Alice', company_id: 'comp-123' },
}

// Update rules tanpa restart
runtime.updateRules(newRules)
```

## Logic

| Rules | Caller | Result |
|-------|--------|--------|
| Tidak ada rules | siapapun | ✅ allow (default `*`) |
| `allow` untuk `role:admin` | caller role `admin` | ✅ allow |
| `allow` untuk `role:admin` | caller role `member` | ❌ deny |
| `deny` untuk `role:viewer` | caller role `viewer` | ❌ deny |
| `deny` untuk `role:viewer` | caller role `admin` | ✅ allow (tidak match) |
| Tool `permission: '*'` | siapapun | ✅ always allow (bypass check) |

## Agent Permission

Agent otomatis expose permission per mode:
- `social_manager:chat` — akses chat mode
- `social_manager:task` — akses task mode

## Known Limitations

- Rules dievaluasi secara sequential per priority — tidak ada kombinasi AND
- Tidak ada wildcard di `resource_id` — harus exact match

## Related Files

- `packages/core/src/resolver/access.ts` — checkAccess() pure function
- `packages/core/src/resolver/scope.ts` — resolveScope() pure function
- `packages/core/src/runtime.ts` — updateRules() method
