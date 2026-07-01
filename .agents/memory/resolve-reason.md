---
name: Resolve reason (motivo) on finalize
description: How the chat finalize "motivo" is captured and stored
---

# Resolve reason (motivo)

When an attendant finalizes a chat (status → resolved), a motive is captured.

- Column: `attendance_logs.resolution_reason` (text, nullable). Stored inside
  `syncResolvedConversation`, which only runs on the resolve TRANSITION
  (locked read of pre-update status inside the txn) — so the reason is written
  exactly once, never on resolved→resolved re-patches.
- Transport: `PATCH /chat/conversations/:id` accepts `resolutionReason`. Server
  sanitizes: only a string is accepted, capped at 500 chars, else null.
- Frontend: predefined motives are a hardcoded FE constant `FINALIZE_REASONS`
  in ChatCenter (NOT admin-configurable by design/scope); "Outro" opens a
  free-text field. Finalize now goes through a modal, not a direct PATCH.
- Displayed in: AdminDashboard history table ("Motivo" column) and
  CrmContactDetail service-history timeline. Both read attendance_logs.

**Why:** requested feature "criar opção de motivo para finalizar o atendimento".
Kept motives hardcoded to avoid scope creep (no new managed-list table/CRUD).
