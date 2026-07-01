import { EventEmitter } from "events";

export const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(200);

// ─── Replay buffer for reconnect recovery ──────────────────────────────────
// Every broadcast event gets a monotonic id and is kept in a bounded in-memory
// ring buffer. When a client reconnects, EventSource sends the id of the last
// event it received in the `Last-Event-ID` header; the SSE endpoint replays the
// buffered events newer than that id (applying the same per-connection scope
// filter) so messages that arrived during the disconnection are not lost.
export interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
  sectorId: number | null;
  isPotential: boolean;
}

const MAX_BUFFERED_EVENTS = 1000;
let lastEventId = 0;
const eventBuffer: BufferedEvent[] = [];

export function currentEventId(): number {
  return lastEventId;
}

export function oldestBufferedId(): number | null {
  return eventBuffer.length ? eventBuffer[0]!.id : null;
}

// Returns the buffered events with an id strictly greater than `sinceId`, in
// arrival order. Does not apply any scope filter — callers must filter.
export function bufferedEventsSince(sinceId: number): BufferedEvent[] {
  return eventBuffer.filter((e) => e.id > sinceId);
}

// Decides how a reconnecting client should be recovered.
// - "replay": all missed events are still buffered; replay them.
// - "resync": too much was missed (evicted from the buffer) or the server
//   counter reset (restart); the client must refetch from REST instead.
// - "current": the client is already up to date; nothing to do.
export function reconnectStrategy(sinceId: number): "replay" | "resync" | "current" {
  if (sinceId > lastEventId) return "resync"; // server restarted / counter reset
  if (sinceId === lastEventId) return "current";
  const oldest = oldestBufferedId();
  if (oldest == null) return "current";
  // Missed events are sinceId+1 .. lastEventId. They are fully retained only if
  // the buffer reaches back to (or before) sinceId+1.
  if (sinceId < oldest - 1) return "resync";
  return "replay";
}

export function broadcast(
  event: string,
  data: unknown,
  sectorId?: number | null,
  isPotential?: boolean,
): void {
  lastEventId += 1;
  const payload: BufferedEvent = {
    id: lastEventId,
    event,
    data,
    sectorId: sectorId ?? null,
    isPotential: isPotential ?? false,
  };
  eventBuffer.push(payload);
  if (eventBuffer.length > MAX_BUFFERED_EVENTS) {
    eventBuffer.splice(0, eventBuffer.length - MAX_BUFFERED_EVENTS);
  }
  sseEmitter.emit("broadcast", payload);
}

// Internal team chat targeting. `recipientIds` is the set of user ids that
// should receive the event; pass `null` to reach every connected user (used by
// the general/team room).
export function broadcastInternal(
  event: string,
  data: unknown,
  recipientIds: number[] | null,
): void {
  sseEmitter.emit("internal", { event, data, recipientIds });
}
