// Atendimento por canais (pedido do Samuel, 26/10/2026): "separar os
// atendimentos por canais, pois mistura todos os números conectados".
//
// Este arquivo concentra as regras que o servidor (listagem, contagens,
// painel do admin, agendador) e a tela (ChatCenter.tsx espelha as mesmas
// funções puras) precisam concordar:
//
// 1) CANAL: "todos" | "instagram" | "wa:<session_key>". Linha de WhatsApp do
//    tipo "interna" (Compras, ADM, fornecedores) fica fora do "Todos" quando
//    pedido (excludeInternal), fora do alarme e dos indicadores.
// 2) "RESPONDER AGORA" x "AGUARDANDO CLIENTE" (dentro dos atendimentos com
//    responsável): a vez é nossa quando o cliente falou por último — a não
//    ser que alguém tenha marcado "Não precisa responder" depois da última
//    mensagem, ou que a conversa esteja em "Retomar depois" com horário
//    ainda no futuro. Tudo por comparação de horários com last_message_at,
//    sem precisar mexer no recebimento de mensagens: mensagem nova do cliente
//    (last_message_at maior) desfaz o "não precisa responder" e cancela o
//    "retomar depois" na hora.
import { sql, type SQL } from "drizzle-orm";
import { conversationsTable } from "@workspace/db";

export const LINE_TYPES = ["varejo", "atacado", "interna"] as const;
export type LineType = typeof LINE_TYPES[number];

export function isLineType(v: unknown): v is LineType {
  return typeof v === "string" && (LINE_TYPES as readonly string[]).includes(v);
}

// ─── Canal ─────────────────────────────────────────────────────────────────
export type ChannelId = string; // "todos" | "instagram" | `wa:${string}`

const SESSION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Valida e normaliza um canal vindo da tela. null = inválido. */
export function parseChannelId(raw: unknown): ChannelId | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v === "todos" || v === "instagram") return v;
  if (v.startsWith("wa:") && SESSION_KEY_RE.test(v.slice(3))) return v;
  return null;
}

/** Filtro de canal para as consultas de conversas. */
export type ChannelFilter = {
  sessionKey?: string;
  instagram?: boolean;
  /** "Todos" sem as linhas internas: lista de session_keys internas da loja. */
  excludeSessionKeys?: string[];
};

export function channelFilterFromQuery(q: Record<string, unknown>, internalKeys: string[]): ChannelFilter {
  const f: ChannelFilter = {};
  const sk = typeof q["sessionKey"] === "string" ? q["sessionKey"] : "";
  if (q["channel"] === "instagram") f.instagram = true;
  else if (sk && SESSION_KEY_RE.test(sk)) f.sessionKey = sk;
  else if (q["excludeInternal"] === "1" || q["excludeInternal"] === "true") f.excludeSessionKeys = internalKeys;
  return f;
}

export function channelCondition(f: ChannelFilter): SQL | null {
  const c = conversationsTable;
  if (f.instagram) return sql`${c.channel} = 'instagram'`;
  if (f.sessionKey) return sql`(${c.sessionKey} = ${f.sessionKey} AND ${c.channel} <> 'instagram')`;
  if (f.excludeSessionKeys && f.excludeSessionKeys.length) {
    return sql`(${c.channel} = 'instagram' OR ${c.sessionKey} NOT IN (${sql.join(f.excludeSessionKeys.map((k) => sql`${k}`), sql`, `)}))`;
  }
  return null;
}

/** Chave do canal de uma conversa ("instagram" ou "wa:<linha>"). */
export function channelOf(conv: { channel: string; sessionKey: string }): ChannelId {
  return conv.channel === "instagram" ? "instagram" : `wa:${conv.sessionKey}`;
}

// ─── Responder agora x Aguardando cliente ─────────────────────────────────
export type ReplyStateInput = {
  status: string;
  isArchived?: boolean | null;
  lastMessageDirection: string | null;
  lastMessageAt: Date | string | null;
  replyDismissedAt?: Date | string | null;
  snoozeUntil?: Date | string | null;
  snoozeSetAt?: Date | string | null;
};

function ms(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const t = typeof v === "string" ? Date.parse(v) : v.getTime();
  return Number.isFinite(t) ? t : null;
}

/** "Retomar depois" marcado e ninguém falou desde então. */
export function snoozeActive(c: ReplyStateInput): boolean {
  const until = ms(c.snoozeUntil);
  const setAt = ms(c.snoozeSetAt);
  if (until == null || setAt == null) return false;
  return setAt >= (ms(c.lastMessageAt) ?? 0);
}

/**
 * Desde quando o cliente espera a nossa resposta (ms), ou null quando a vez
 * não é nossa. Vale pra qualquer conversa em aberto; a aba "Responder agora"
 * usa isso só nas que têm responsável.
 */
export function waitingSince(c: ReplyStateInput, now: number): number | null {
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

export function needsReply(c: ReplyStateInput, now: number): boolean {
  return waitingSince(c, now) != null;
}

// Mesma regra em SQL (para contagens e listagem no banco).
const c = conversationsTable;
const lastAt = sql`coalesce(${c.lastMessageAt}, 'epoch'::timestamptz)`;
export const SQL_SNOOZE_ACTIVE = sql`(${c.snoozeUntil} IS NOT NULL AND ${c.snoozeSetAt} IS NOT NULL AND ${c.snoozeSetAt} >= ${lastAt})`;
/** A vez é nossa (cliente esperando resposta). Não olha status/responsável. */
export const SQL_NEEDS_REPLY = sql`(CASE WHEN ${SQL_SNOOZE_ACTIVE} THEN ${c.snoozeUntil} <= now()
  ELSE (${c.lastMessageDirection} = 'inbound' AND ${c.lastMessageAt} IS NOT NULL
        AND (${c.replyDismissedAt} IS NULL OR ${c.replyDismissedAt} < ${c.lastMessageAt})) END)`;
/** Desde quando espera (só faz sentido junto com SQL_NEEDS_REPLY). */
export const SQL_WAITING_SINCE = sql`(CASE WHEN ${SQL_SNOOZE_ACTIVE} THEN ${c.snoozeUntil} ELSE ${c.lastMessageAt} END)`;
export const SQL_ACTIVE = sql`(${c.assigneeId} IS NOT NULL AND ${c.status} NOT IN ('resolved', 'archived'))`;
export const SQL_RESPONDER = sql`(${SQL_ACTIVE} AND ${SQL_NEEDS_REPLY})`;
export const SQL_AGUARDANDO = sql`(${SQL_ACTIVE} AND NOT ${SQL_NEEDS_REPLY})`;

// ─── Retomar depois: opções da tela ───────────────────────────────────────
export const MAX_SNOOZE_DAYS = 60;

/** Valida o horário pedido: no futuro e até 60 dias. */
export function validSnoozeUntil(raw: unknown, now: number): Date | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const t = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  if (t <= now + 30_000) return null;
  if (t > now + MAX_SNOOZE_DAYS * 86_400_000) return null;
  return new Date(t);
}
