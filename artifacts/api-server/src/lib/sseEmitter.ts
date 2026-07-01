import { EventEmitter } from "events";

export const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(200);

export function broadcast(
  event: string,
  data: unknown,
  sectorId?: number | null,
  isPotential?: boolean,
): void {
  sseEmitter.emit("broadcast", {
    event,
    data,
    sectorId: sectorId ?? null,
    isPotential: isPotential ?? false,
  });
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
