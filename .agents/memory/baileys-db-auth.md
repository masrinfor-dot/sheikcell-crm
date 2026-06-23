---
name: Baileys DB auth state
description: How WhatsApp session persistence works — Baileys writes all auth keys/creds to PostgreSQL instead of the filesystem.
---

# Baileys DB-backed auth state

**Why:** Filesystem-based Baileys sessions (`sessions/default/*.json`) are wiped on re-deployment or container restart, forcing QR re-scan. PostgreSQL persists across restarts.

## Tables
- `whatsapp_auth_state(session_key, data_key, value, updated_at)` — raw Baileys key-value auth material (creds + signal keys). PK is (session_key, data_key).
- `whatsapp_sessions(session_key, status, phone_number, phone_id, error_message, last_heartbeat_at, updated_at)` — high-level connection state cache for Admin UI.

## Key files
- `artifacts/whatsapp-bridge/src/lib/dbAuthState.ts` — implements `useDatabaseAuthState(sessionKey)` replacing `useMultiFileAuthState`
- `artifacts/whatsapp-bridge/src/lib/waConnection.ts` — Baileys socket lifecycle: connect, QR gen, creds.update → saveCreds, exponential backoff reconnect
- `artifacts/whatsapp-bridge/src/lib/whatsapp.ts` — public WAState interface; Baileys primary, Meta Cloud API secondary fallback
- `artifacts/api-server/src/routes/whatsapp.ts` — proxies status/reset/send; writes to `whatsapp_sessions` on every poll

## How to apply
- When adding new Baileys features, always go through `waConnection.ts` — never create a second socket instance.
- `useDatabaseAuthState` uses `initAuthCreds()` from `@whiskeysockets/baileys` (not `@baileys/baileys`) for Baileys v7.
- The bridge package.json must declare `@workspace/db workspace:*` and `drizzle-orm catalog:` as runtime deps.
- `SignalKeyStore.get` must use explicit generic cast (`val as SignalDataTypeMap[T]`) to satisfy TypeScript — the DB stores JSON, not typed values.

**Why:** Any return type broader than `SignalDataTypeMap[T]` will fail the strict generic constraint in Baileys' SignalKeyStore interface.
