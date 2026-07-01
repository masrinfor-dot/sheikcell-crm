---
name: Chat module architecture
description: How the Central de Atendimento (chat) module is built — SSE, API methods, DB tables, seeded data
---

## Rule
The Central de Atendimento uses Server-Sent Events (SSE) for real-time updates, not WebSockets.

**Why:** Simpler to implement with Express; app-wide SSE endpoint at `GET /api/chat/events`.

**How to apply:**
- Frontend connects via `new EventSource(...)` inside `ChatCenter.tsx`
- SSE emitter singleton at `artifacts/api-server/src/lib/sseEmitter.ts` — call `broadcast(event, data, sectorId, isPotential)` from any route; the `/chat/events` handler filters per-subscriber by role/sector
- DB tables: `conversations` + `messages` (lib/db/src/schema/conversations.ts)
- All chat API methods live in `api.ts` under `api.chat.*` (no Orval codegen)
- Demo data: 10 conversations, 27 messages seeded June 23 2026
- WhatsApp webhook endpoint: `POST /api/chat/webhook/whatsapp` (Evolution API / Z-API format)

## Inbound alerts (sound + browser notification) live only in ChatCenter
Background-tab alerts for new inbound messages are gated on `document.hidden || conversationId !== activeId`; sound is a synthesized Web Audio beep (no asset), browser Notification requires user-granted permission. Prefs persist in localStorage (`chat.alertSound`, `chat.alertDesktop`) and are read via refs so toggling doesn't re-subscribe the SSE.

**Gotcha:** The chat EventSource is mounted inside `ChatCenter.tsx` and closes when the attendant navigates to another route — so alerts only fire while the Central de Atendimento screen is mounted (a background browser tab counts; a different in-app route does not). True app-wide notifications would need an app-level SSE subscription.

## Etiquetas (chat labels) are DB-backed
Chat etiquetas live in the `chat_labels` table (name + color), managed via `api.chat.labels.*`. Read is for any authed user; create/update/delete require admin/supervisor.

**Why:** Replaced the old hardcoded `LABELS_OPTIONS` array so users manage their own list.

**Gotcha:** A conversation stores applied labels as a comma-separated string of NAMES (conversations.labels), NOT label IDs. Renaming or deleting a label leaves stale name strings on existing conversations — there is no cascade.
