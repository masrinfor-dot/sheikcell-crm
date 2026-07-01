---
name: SSE reconnect recovery
description: How /chat/events recovers messages missed during a dropped SSE connection
---

# SSE reconnect recovery (Last-Event-ID replay)

`/chat/events` uses a server-side replay buffer so messages broadcast while a
client's `EventSource` is disconnected are not lost.

- `sseEmitter.ts` owns a monotonic `lastEventId` counter and a bounded ring
  buffer (`MAX_BUFFERED_EVENTS`). `broadcast()` assigns each event an id, pushes
  it to the buffer, then emits. The endpoint writes an `id:` line per event so
  the browser tracks it and resends it as the `Last-Event-ID` header on reconnect.
- On (re)connect the endpoint reads `Last-Event-ID`. `reconnectStrategy(sinceId)`
  returns `replay` (events still buffered — replay those with id > sinceId,
  applying the SAME scope filter as live delivery), `resync` (gap too large /
  buffer evicted, OR `sinceId > lastEventId` meaning the server restarted →
  emit a `resync` event), or `current` (nothing missed).
- Replayed `message`/`conversation_new`/`conversation_updated` events flow
  through the client's existing handlers, so the notification bell and lists
  self-heal with no extra client logic.
- Client handles the `resync` event by calling `fetchConvs()` + `fetchMsgs(activeId)`.

**Why:** a fresh connect (no `Last-Event-ID`) must NOT replay the whole buffer —
that would duplicate REST-loaded messages and spam the bell. Replay only fires
when the header is present.

**How to apply:** the per-connection scope filter (`allowed`) must be applied to
BOTH live and replayed events, or replay would leak cross-sector data to
vendedores. Any new broadcast event type is automatically buffered/replayed.
