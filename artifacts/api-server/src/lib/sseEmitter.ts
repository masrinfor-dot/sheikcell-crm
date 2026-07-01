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
