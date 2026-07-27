---
name: CRM real-time sync
description: How the CRM board stays in sync with the chat (SSE events + attendant mirroring)
---

- CRM board + Visão Geral reuse the chat SSE channel (`/api/chat/events`) listening to `crm_contact_created/updated/deleted`; broadcast with the contact's sectorId, isPotential=false.
- The CRM card's "atendente" mirrors the conversation assignee: `syncCrmAttendant` (crmSync) is called on claim and on any PATCH that changes assigneeId. It matches contact by normalized phone + sector, updates attendantId, and broadcasts `crm_contact_updated` itself (best-effort, never throws).
- `ensureCrmContactForConversation` also sets attendantId on the existing-contact branch when the conversation already has an assignee (e.g. vendedor-created convs are born assigned).
- **Why:** without mirroring, the CRM card showed a stale/empty attendant while the chat moved on ("CRM não acompanha o fluxo").
- **How to apply:** any new code path that changes `conversations.assigneeId` must call `syncCrmAttendant` afterwards, or the CRM card drifts.

Related rules added in the same change:
- Vendedor transfer: PATCH assigneeId requires perm `transferir`; target must be an active user; when caller is vendedor, target must be role vendedor and same sector as the conversation; vendedor cannot set assigneeId=null; status forced "open" on vendedor transfer.
- Claim is atomic: `UPDATE ... WHERE assignee_id IS NULL OR assignee_id = me`, 409 if no row.
- unreadCount only cleared when the viewer is the assignee (or a vendedor if unassigned) — admin/supervisor peeking must not clear the vendedor's notification.
