// Atendimento por canais (26/10/2026) — espelho, na tela, das regras de
// artifacts/api-server/src/lib/attendanceState.ts (mantenha as duas iguais):
// de quem é a vez ("Responder agora" x "Aguardando cliente"), "Não precisa
// responder" e "Retomar depois". Tudo por comparação de horários com a
// última mensagem, então a conversa muda de aba sozinha quando o cliente
// escreve (evento em tempo real) ou quando chega o horário combinado.
import type { Conversation } from "./api";

type ReplyFields = Pick<Conversation, "status" | "isArchived" | "lastMessageDirection" | "lastMessageAt">
  & Partial<Pick<Conversation, "replyDismissedAt" | "snoozeUntil" | "snoozeSetAt">>;

function ms(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** "Retomar depois" marcado e ninguém falou desde então. */
export function snoozeActive(c: ReplyFields): boolean {
  const until = ms(c.snoozeUntil);
  const setAt = ms(c.snoozeSetAt);
  if (until == null || setAt == null) return false;
  return setAt >= (ms(c.lastMessageAt) ?? 0);
}

/** Horário do "retomar" ainda no futuro (selo "retomar …"). */
export function snoozePending(c: ReplyFields, now: number): boolean {
  return snoozeActive(c) && (ms(c.snoozeUntil) ?? 0) > now;
}

/** Desde quando o cliente espera a nossa resposta (ms), ou null. */
export function waitingSince(c: ReplyFields, now: number): number | null {
  if (c.isArchived || c.status === "resolved" || c.status === "archived") return null;
  if (snoozeActive(c)) {
    const until = ms(c.snoozeUntil)!;
    return until <= now ? until : null;
  }
  if (c.lastMessageDirection !== "inbound") return null;
  const last = ms(c.lastMessageAt);
  if (last == null) return null;
  const dismissed = ms(c.replyDismissedAt);
  if (dismissed != null && dismissed >= last) return null;
  return last;
}

export function needsReply(c: ReplyFields, now: number): boolean {
  return waitingSince(c, now) != null;
}

// ─── Canal ─────────────────────────────────────────────────────────────────
// "todos" | "instagram" | "wa:<linha>"
export function channelOfConv(c: Pick<Conversation, "channel" | "sessionKey">): string {
  return c.channel === "instagram" ? "instagram" : `wa:${c.sessionKey ?? "default"}`;
}

/** Texto curto do horário de "retomar" ("hoje 17:00", "amanhã 10:00", "29/10 10:00"). */
export function snoozeLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const tz = "America/Sao_Paulo";
  const key = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: tz });
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  if (key(d) === key(new Date(now))) return `hoje ${hm}`;
  if (key(d) === key(new Date(now + 86_400_000))) return `amanhã ${hm}`;
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: tz })} ${hm}`;
}

/**
 * Opções rápidas do "Retomar depois": em 1 hora, hoje 17h (só se ainda não
 * passou), amanhã 10h, em 3 dias (10h). Horário de Brasília (UTC-3, sem
 * horário de verão desde 2019).
 */
export function snoozeOptions(now = Date.now()): { label: string; until: Date }[] {
  const BRT = -3 * 3600_000;
  const local = new Date(now + BRT); // "relógio" de Brasília lido em UTC
  const at = (daysAhead: number, hour: number) =>
    new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysAhead, hour, 0, 0) - BRT);
  const opts: { label: string; until: Date }[] = [{ label: "em 1 hora", until: new Date(now + 3600_000) }];
  const today17 = at(0, 17);
  if (today17.getTime() > now + 15 * 60_000) opts.push({ label: "hoje 17h", until: today17 });
  opts.push({ label: "amanhã 10h", until: at(1, 10) });
  opts.push({ label: "em 3 dias", until: at(3, 10) });
  return opts;
}

// ─── Horário da loja (quadro, fase 2 — 29/10/2026) ───────────────────────
// "Pra não amanhecer tudo vermelho": com o horário configurado, a espera do
// cliente só conta com a loja aberta. Fora do horário a conversa fica
// "pausada" (sem vermelho/alarme); ao abrir, conta a partir da abertura.
// Horário de Brasília (UTC-3, sem horário de verão desde 2019).
export type StoreHours = { open: string; close: string; days: number[] } | null | undefined;

export function businessWait(since: number, now: number, hours: StoreHours): { since: number; paused: boolean } {
  if (!hours) return { since, paused: false };
  const BRT = -3 * 3600_000;
  const local = new Date(now + BRT);
  const [oh, om] = hours.open.split(":").map(Number) as [number, number];
  const [ch, cm] = hours.close.split(":").map(Number) as [number, number];
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const open = oh * 60 + om, close = ch * 60 + cm;
  if (!hours.days.includes(local.getUTCDay()) || minutes < open || minutes >= close) return { since, paused: true };
  const todayOpen = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), oh, om) - BRT;
  return { since: Math.max(since, todayOpen), paused: false };
}
