---
name: WhatsApp inbound message flow
description: How customer (inbound) WhatsApp messages reach the attendance tab, and the webhook trust model for a Baileys deployment
---

# WhatsApp inbound flow (Baileys bridge → API → attendance tab)

Inbound customer messages only reach the app if the Baileys bridge has a
`messages.upsert` listener that forwards each message to the API webhook
`POST /api/chat/webhook/whatsapp`. Without that listener, messages are received
by Baileys but never persisted/broadcast, so the attendance tab stays empty.

**Why:** the bridge originally only handled `creds.update` + `connection.update`;
there was no inbound forwarding at all. This is the single point that makes or
breaks inbound.

## Webhook trust model (important decision)

The webhook authenticates one of two ways:
- If `META_WHATSAPP_WEBHOOK_SECRET` is set → verify Meta `X-Hub-Signature-256`.
- Otherwise → verify the HMAC bridge secret (`x-bridge-secret`, timing-safe).

**Decision:** the bridge-secret path is allowed in BOTH dev and production.
**Why:** this deployment is Baileys-only (no Meta Cloud API). A prior hardening
made the webhook fail-closed in production unless the Meta secret was set, which
silently broke all inbound messages in the published app. The bridge secret is
HMAC-SHA256 of `SESSION_SECRET` (always present in prod) compared timing-safe, so
it is a strong authenticated channel, not a fail-open webhook.
**How to apply:** if you ever re-harden this webhook, do NOT reintroduce a
prod-only fail-closed branch unless the user has actually switched to Meta Cloud
API — it will break Baileys inbound.

## Security caveat (open)

Baileys auth/session files (`creds.json`, app-state-sync keys) must never be
committed. `artifacts/whatsapp-bridge/sessions/` is now gitignored, but files
committed earlier remain tracked in history until untracked + the session is
re-paired/rotated.
