---
name: Vendedor sector scoping
description: How vendedor conversation visibility is scoped and why it must fail closed
---

## Rule
Vendedores (non admin/supervisor) must ALWAYS be sector-scoped in the chat module and must never see the full conversation history. Any scoping branch must fail closed: a vendedor with no valid sector sees ONLY potenciais (never all conversations).

**Why:** A past bug let vendedores see every conversation. Two causes: (1) `users.sector_id` was declared `serial` (auto-increment) instead of an integer FK, so users got sequence values that mapped to no real sector; (2) the conversation-list and SSE filters skipped scoping entirely when the user's sector was falsy — fail open. Threat model requires vendedores be sector-scoped.

**How to apply:**
- `users.sector_id` is a nullable integer FK to `sectors.id` — never `serial`. Real sector IDs are the FK target; a bare integer with no FK invites drift.
- The three places that must stay consistent for a vendedor: `GET /chat/conversations` list filter, `canAccessConversation` (single conv / messages / mutations), and the `/chat/events` SSE `send` filter. All three: allow if potencial OR (sector present AND equals the user's sector); otherwise deny. A null conversation sector never matches a vendedor.
- Potenciais (unassigned + open, status not in pending/resolved/archived) are intentionally cross-sector visible so any vendedor can claim them — this is by design, not a leak.
