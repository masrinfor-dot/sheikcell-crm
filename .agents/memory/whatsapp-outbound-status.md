---
name: WhatsApp outbound delivery status
description: Why outbound WhatsApp messages can appear "sent" but never reach the customer, and how failures are surfaced
---

# WhatsApp outbound: "new conversations don't work" is usually a pairing problem

The #1 cause of "conversas iniciadas pelo sistema não funcionam" is that the
Baileys bridge is running but **not paired** (status `qr` — a QR code is waiting
to be scanned in the admin WhatsApp tab). No WhatsApp session = nothing is
delivered, even though the API and wiring are fine. Check `/api/whatsapp/status`
first (admin-only); `status: "qr"` means: scan the QR to reconnect.

Creating a conversation (`POST /chat/conversations`) only inserts a DB row — it
does NOT send any message to the customer. The customer receives nothing until
staff sends the first message.

## Delivery-failure semantics (decision)

Outbound message rows are inserted with `status: "sent"` BEFORE the bridge call.
If the bridge returns non-OK or is unreachable, the row is updated to
`status: "failed"` and a `message_updated` SSE event is broadcast (same
sector/potential scoping as the original `message` event). The frontend listens
for `message_updated`, replaces the bubble by message id, and shows a red
"Não entregue" indicator when `status === "failed"`.

**Why:** previously delivery failures were only logged (`req.log.warn`) and the
message stayed `status: "sent"`, so staff had no idea the customer never got it —
the failure was completely silent. Both send paths (text and media) must keep
this failed-status + `message_updated` behavior in lockstep.

**How to apply:** any new outbound path to the bridge must set the row to
`failed` on non-OK/unreachable and broadcast `message_updated`, or it
reintroduces the silent-failure bug.
