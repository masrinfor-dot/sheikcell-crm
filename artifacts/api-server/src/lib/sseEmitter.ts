import { EventEmitter } from "events";

export const sseEmitter = new EventEmitter();

// ── Presença: quem está com o painel aberto agora ──────────────────────────
// Conta conexões SSE por usuário (várias abas = vários "refs") e guarda o
// último instante em que cada um esteve conectado.
const presenceRefs = new Map<number, number>();
const lastSeenAt = new Map<number, Date>();

export function presenceConnect(userId: number): void {
  presenceRefs.set(userId, (presenceRefs.get(userId) ?? 0) + 1);
  lastSeenAt.set(userId, new Date());
}

export function presenceDisconnect(userId: number): void {
  const n = (presenceRefs.get(userId) ?? 1) - 1;
  if (n <= 0) presenceRefs.delete(userId);
  else presenceRefs.set(userId, n);
  lastSeenAt.set(userId, new Date());
}

export function getPresence(): { onlineIds: number[]; lastSeen: Record<number, string> } {
  const lastSeen: Record<number, string> = {};
  for (const [id, d] of lastSeenAt) lastSeen[id] = d.toISOString();
  return { onlineIds: [...presenceRefs.keys()], lastSeen };
}
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
  // Loja (tenant) dona do evento. Eventos NUNCA cruzam a fronteira de loja:
  // o endpoint SSE só entrega quando tenantId bate com o da sessão do cliente.
  tenantId: number;
  sectorId: number | null;
  isPotential: boolean;
  // Conversas restritas (com responsável ou finalizadas): lista de userIds que
  // podem receber o evento (responsável + participantes). null = escopo normal
  // por setor/potencial. Admin sempre recebe; supervisor recebe se o setor bate.
  restrictedTo: number[] | null;
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

// Multi-loja: tenantId é OBRIGATÓRIO — todo evento pertence a uma loja e o
// endpoint SSE só entrega para clientes da mesma loja (fail closed).
export function broadcast(
  event: string,
  data: unknown,
  scope: {
    tenantId: number;
    sectorId?: number | null;
    isPotential?: boolean;
    restrictedTo?: number[] | null;
  },
): void {
  lastEventId += 1;
  const payload: BufferedEvent = {
    id: lastEventId,
    event,
    data,
    tenantId: scope.tenantId,
    sectorId: scope.sectorId ?? null,
    isPotential: scope.isPotential ?? false,
    restrictedTo: scope.restrictedTo ?? null,
  };
  eventBuffer.push(payload);
  if (eventBuffer.length > MAX_BUFFERED_EVENTS) {
    eventBuffer.splice(0, eventBuffer.length - MAX_BUFFERED_EVENTS);
  }
  sseEmitter.emit("broadcast", payload);
}

// ─── Replay buffer for internal team chat ──────────────────────────────────
// Mirrors the customer-chat replay buffer above, but keyed by `recipientIds`
// (the set of user ids allowed to receive the event) instead of sector scope.
// Internal events get their own monotonic id space and ring buffer so a
// reconnecting internal-chat client can recover messages sent during the
// disconnection without touching the customer-chat counter.
export interface BufferedInternalEvent {
  id: number;
  event: string;
  data: unknown;
  // Multi-loja: evento SEMPRE pertence a uma loja; o SSE rejeita qualquer
  // evento cuja loja não seja a da sessão (inclusive no replay).
  tenantId: number;
  recipientIds: number[] | null;
}

const MAX_BUFFERED_INTERNAL_EVENTS = 1000;
let lastInternalEventId = 0;
const internalEventBuffer: BufferedInternalEvent[] = [];

export function currentInternalEventId(): number {
  return lastInternalEventId;
}

export function oldestBufferedInternalId(): number | null {
  return internalEventBuffer.length ? internalEventBuffer[0]!.id : null;
}

// Returns buffered internal events with an id strictly greater than `sinceId`,
// in arrival order. Does not apply the recipient filter — callers must filter.
export function bufferedInternalEventsSince(sinceId: number): BufferedInternalEvent[] {
  return internalEventBuffer.filter((e) => e.id > sinceId);
}

export function reconnectInternalStrategy(sinceId: number): "replay" | "resync" | "current" {
  if (sinceId > lastInternalEventId) return "resync"; // server restarted / counter reset
  if (sinceId === lastInternalEventId) return "current";
  const oldest = oldestBufferedInternalId();
  if (oldest == null) return "current";
  if (sinceId < oldest - 1) return "resync";
  return "replay";
}

// Internal team chat targeting. `recipientIds` is the set of user ids that
// should receive the event; pass `null` to reach every connected user DA LOJA
// (used by the general/team room — o tenantId limita o alcance). Buffered for
// reconnect replay.
export function broadcastInternal(
  event: string,
  data: unknown,
  tenantId: number,
  recipientIds: number[] | null,
): void {
  lastInternalEventId += 1;
  const payload: BufferedInternalEvent = {
    id: lastInternalEventId,
    event,
    data,
    tenantId,
    recipientIds,
  };
  internalEventBuffer.push(payload);
  if (internalEventBuffer.length > MAX_BUFFERED_INTERNAL_EVENTS) {
    internalEventBuffer.splice(0, internalEventBuffer.length - MAX_BUFFERED_INTERNAL_EVENTS);
  }
  sseEmitter.emit("internal", payload);
}
