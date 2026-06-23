import { EventEmitter } from "events";

export const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(200);

export function broadcast(event: string, data: unknown): void {
  sseEmitter.emit("broadcast", { event, data });
}
