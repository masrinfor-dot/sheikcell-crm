---
name: WhatsApp multi-session
description: Multiple WhatsApp numbers via Baileys sessions — key rules for routing, lifecycle, and UI
---

- Each connection = a `sessionKey` (slug, regex `^[a-z0-9][a-z0-9_-]{0,39}$`), `default` is the primary and can never be removed.
- Conversations are upserted by **phone + sessionKey** — the same customer on two numbers is two conversations, so replies always leave through the number the customer contacted. Outbound send/send-media must pass `session: conv.sessionKey` to the bridge.
- Deleting a connection reassigns its conversations to `default`.
- **Why:** mixing sessions on outbound would answer customers from a different number than they wrote to.
- **How to apply:** any new send path (campaigns, automations) must read the conversation's `sessionKey`; any invalid/absent key falls back to `default` on inbound but is rejected (400) on admin routes.
- Bridge `startSession` must stay idempotent (no-op when socket already open/qr/connecting) — the api-server list endpoint auto-starts missing sessions on every poll, which would otherwise spawn parallel Baileys sockets (ban risk).
- Meta Cloud API fallback applies to the `default` session only.
