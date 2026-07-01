---
name: CRM real-time sync
description: How CRM board + Visão Geral stay live and which SSE channel they reuse
---

# CRM real-time sync

CRM does NOT have its own SSE stream. It piggybacks on the chat channel
`/api/chat/events`. CRM mutations broadcast `crm_contact_created` /
`crm_contact_updated` / `crm_contact_deleted` via the shared `broadcast(event,
payload, sectorId, isPotential=false)`.

**Rule:** always broadcast CRM events with the contact's own `sectorId` and
`isPotential=false` so the shared SSE `send` filter scopes them exactly like chat
(globals get all; a vendedor only gets same-sector, never null-sector). On admin
sector reassignment (PATCH changes `sectorId`), emit an `updated` to the new
sector AND a `crm_contact_deleted` to the OLD sector so the origin board drops the
row (same pattern as chat transfer). Archiving via PATCH `isArchived:true` or
DELETE both emit `crm_contact_deleted`.

**Why:** one channel avoids a second EventSource per client and keeps sector
isolation logic in one place. Broadcasting after `res.json(...)` keeps response
latency low.

**How to apply:**
- Consumers: `CrmBoard.tsx` upserts/removes by id; while a `search` is active it
  debounces a scoped refetch instead of surgical upsert (server-side search spans
  many fields, can't be judged client-side). `AdminDashboard.tsx` (Visão Geral)
  debounces `fetchAll()` on `crm_*` + `conversation_*` events.
- Any new CRM mutation path that changes a contact must also broadcast, or boards
  go stale. Purchase add/delete use `broadcastContactUpdate(id)` (profile/total
  can change).
- CRM scoping is fail-closed on null sector (see vendedor-scoping.md): a
  sector-scoped user with no sector sees nothing; null-sector contacts are never
  visible to non-global users.
