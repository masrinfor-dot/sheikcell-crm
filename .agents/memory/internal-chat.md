---
name: Internal team chat
description: How the internal team chat (admin/supervisor/vendedor colleague messaging) is structured, separate from customer-facing Central de Atendimento
---

# Internal team chat ("Chat Interno" / "Equipe")

Team-internal messaging between staff, distinct from the customer-facing
Central de Atendimento (customer `conversations`). No sector scoping — any staff
member can message any other, and everyone shares one general room.

## Model
- `internal_conversations` has `kind` = `direct` | `general`.
- Direct = exactly 2 members; found-or-created by member pair.
- General = one singleton "Equipe (Geral)" room; auto-seeded lazily.

## Singleton general room — the sharp edge
There must be exactly ONE `kind='general'` row, otherwise members fragment
across different room IDs and history splits.
**Why:** lazy select-then-insert races under concurrent first access created
duplicate general rooms.
**How to apply:** a partial unique index on `internal_conversations(kind)` where
`kind='general'` enforces it at the DB level; room creation must be
conflict-safe (insert `onConflictDoNothing` then re-select), never rely on a
plain select-then-insert.

## Real-time
Separate SSE channel from customer chat: `broadcastInternal(event, data, recipientIds)`
emits on the `sseEmitter` "internal" event; `recipientIds = null` means the
general room (everyone). The `/internal-chat/events` endpoint filters by whether
the connected user's id is in `recipientIds`. Do not reuse the customer chat's
sector-based `broadcast` — it filters by sector and would leak/lose events.

## Authorization
Non-general conversations require membership before read/post/mark-read
(`getAccessibleConversation`); general auto-ensures the caller's membership row
(needed for per-user unread tracking).
