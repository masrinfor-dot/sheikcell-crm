---
name: Chat module architecture
description: How the Central de Atendimento (chat) module is built — SSE, API methods, DB tables, seeded data
---

## Rule
The Central de Atendimento uses Server-Sent Events (SSE) for real-time updates, not WebSockets.

**Why:** Simpler to implement with Express; SSE endpoint at `GET /api/chat/conversations/:id/stream`.

**How to apply:**
- Frontend connects via `new EventSource(...)` inside `ChatCenter.tsx`
- SSE emitter singleton at `artifacts/api-server/src/lib/sseEmitter.ts` — call `broadcast(conversationId, data)` from any route
- DB tables: `conversations` + `messages` (lib/db/src/schema/conversations.ts)
- All chat API methods live in `api.ts` under `api.chat.*` (no Orval codegen)
- Demo data: 10 conversations, 27 messages seeded June 23 2026
- WhatsApp webhook endpoint: `POST /api/chat/webhook/whatsapp` (Evolution API / Z-API format)

## Etiquetas (chat labels) are DB-backed
Chat etiquetas live in the `chat_labels` table (name + color), managed via `api.chat.labels.*`. Read is for any authed user; create/update/delete require admin/supervisor.

**Why:** Replaced the old hardcoded `LABELS_OPTIONS` array so users manage their own list.

**Gotcha:** A conversation stores applied labels as a comma-separated string of NAMES (conversations.labels), NOT label IDs. Renaming or deleting a label leaves stale name strings on existing conversations — there is no cascade.
