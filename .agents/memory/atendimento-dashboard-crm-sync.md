---
name: Atendimento ↔ Visão Geral ↔ CRM sync
description: How chat attendances surface in the dashboard and CRM, and the contract that keeps them in sync
---

# Resolving a chat conversation must write an attendance_log

The Visão Geral dashboard (`/admin/summary`) derives "Finalizados/completedToday" and the recent feed **entirely** from `attendance_logs`, grouped by `sectorId`. The CRM service-history view also reads `attendance_logs` (matched by client phone/name). Conversations, queue entries, and CRM contacts do NOT feed the dashboard directly.

**Why:** A finalized chat attendance was previously invisible to both the dashboard and CRM because resolving a conversation only flipped its status and never produced an attendance_log. Any module that should "count" an attendance has to emit an attendance_log at the moment of finalization — that table is the shared ledger.

**How to apply:**
- When a conversation transitions into `resolved`, emit one `attendance_log` (outcome `completed`, `queueEntryId: 0` sentinel since chat has no queue entry) and find-or-create the CRM contact by normalized phone.
- `attendance_logs.sectorId` is NOT NULL — attribute to the conversation's sector, falling back to the assignee's sector; if neither exists it cannot be counted.
- Fire the sync **only on the transition** (compare pre-update status) and do update+sync in one DB transaction with a `FOR UPDATE` locked read, so it logs exactly once even under concurrent PATCHes.
- Scope the CRM phone lookup to the attendance's effective sector (same global-vs-sector rule as the rest of CRM) so a same-phone contact in another sector is never read or mutated.
