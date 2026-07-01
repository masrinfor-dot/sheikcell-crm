---
name: Atendimento categories (Potenciais/Pendentes/Ativos/Resolvidas)
description: How ChatCenter buckets conversations into the 3 (+1) Atendimento categories, and the claim flow that moves them.
---

# Atendimento categorization

The Central de Atendimento (ChatCenter) groups conversations into categories derived
from existing `conversations` fields — **no schema column** was added for this.

Mapping (priority order, see `conversationCategory()` in ChatCenter):
1. **Resolvidas** — `isArchived || status === resolved/archived` (finished; kept as a 4th tab so resolving doesn't orphan conversations from the UI).
2. **Ativos** — `assigneeId != null` (a vendedor is handling it).
3. **Pendentes** — `status === pending` and no assignee (filtered, in queue).
4. **Potenciais** — anything else (new/open, no assignee). Future AI will triage these into Pendentes.

**Why no new column:** the three states map cleanly onto status + assignee, and the
user framed it as a workflow over existing inbound conversations (new → filtered →
attended). Adding a column would have needed a migration for no behavioral gain.

## Adding a vendedor as participant routes to Pendentes

Adding a **vendedor** participant (`POST /chat/conversations/:id/participants`) moves
the conversation into **Pendentes** (`status = pending`) so the vendedor can review
and then "Iniciar atendimento" (claim → Ativos). Guard conditions: only when the
added user's role is `vendedor`, `assigneeId == null`, and status is not already
`pending/resolved/archived` — so an active or resolved conversation is never knocked
back into the queue, and adding a supervisor/admin as observer changes nothing.

**Why:** the user wanted assigning a vendedor to double as putting the chat in the
approval queue, not to instantly make them the responsible attendant.

**How to apply:** compute `wasPotential` from the PRE-update conversation before
flipping to pending, then `broadcast("conversation_updated", updated, sectorId,
wasPotential)` — otherwise the potenciais cross-sector SSE scoping leaks (see
potenciais-scoping). The endpoint returns `{ ok, conversation }` so the client can
apply the new status locally without waiting for the SSE round-trip.

## Transitions
- **Potencial → Pendente:** `updateConversation(status: "pending")` ("Enviar para fila"). Stand-in for the future AI filter.
- **Pendente → Ativo:** `POST /chat/conversations/:id/claim` (self-assign). Needed because the PATCH route blocks vendedores from setting `assigneeId`; claim is a sector-scoped self-assignment.

**Claim guard:** claim must reject (409) when `assigneeId` is already set to *another* user — otherwise any same-sector user could steal an in-progress conversation. Re-claiming by the same user is idempotent.
