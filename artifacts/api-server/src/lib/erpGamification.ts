// Pontuação do atendimento → gamificação do ERP Prumo (27/10/2026).
//
// Samuel: "deixar essa gamificação totalmente automatizada". O ERP dá ou
// tira pontos do atendente a partir de 3 momentos das conversas, que só o CRM
// enxerga (contrato v1: POST /integrations/gamification/v1/events, chave com
// o acesso "Eventos de atendimento (gamificação)"):
//
//   1. CONVERSATION_FIRST_RESPONSE — a primeira mensagem do atendente (feita
//      por uma pessoa, não robô/nota) num atendimento em que o cliente tinha
//      falado por último. responseSeconds = da hora em que o cliente ficou
//      esperando (ou em que o atendente assumiu, o que for depois) até a
//      resposta — mesma base do "1ª resposta" do painel do CRM. O ERP decide
//      se foi no prazo (regra dele, padrão 5 min).
//   2. CONVERSATION_UNANSWERED_SLA — conversa com responsável esperando
//      resposta há mais que o limite do alarme "sem resposta" da Central
//      (Configurar alerta; padrão 5 min). Um evento por espera.
//   3. CONVERSATION_CONVERTED — venda concluída no ERP que o próprio ERP
//      atribuiu a um atendente daqui (Vendas do atendimento). O CRM lê essas
//      vendas (GET /integrations/sales/attributed, acesso "Vendas do
//      atendimento") e devolve o evento com o saleId do ERP.
//
// Desenho: varredura a cada minuto (nada muda no envio/recebimento de
// mensagens) → fila (erp_gamification_events, eventId único e determinístico,
// ex.: "conv-8812:first-response:99120") → envio em lotes de até 200 com nova
// tentativa e espera crescente. ERP fora do ar: a fila espera, o CRM segue.
// Só conta o que acontecer depois de ligar (gamification_since).
//
// LGPD: vai só id e número (ids da conversa/venda/loja, segundos) e o
// id + e-mail do ATENDENTE. Nunca texto de mensagem, nome ou celular do cliente.
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  db, appSettingsTable, erpGamificationEventsTable, erpStoreLinksTable, tenantErpIntegrationsTable, usersTable,
  type ErpGamificationItem,
} from "@workspace/db";
import { erpCredentials } from "./erpSalesSync";
import { erpFetch } from "./erpOsMessages";
import { withErpTenant } from "./erpExchanges";
import { logger } from "./logger";

export const GAMIFICATION_PATH = "/integrations/gamification/v1/events";
export const ATTRIBUTED_SALES_PATH = "/integrations/sales/attributed";
export const MAX_ITEMS_PER_CALL = 200;
const CALLS_PER_TICK = 5;
const SCAN_LIMIT = 500;
const MAX_ATTEMPTS = 30;
/** Espera entre tentativas: 1 min, 5 min, 15 min, 1 h, depois 6 h. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
/** Chave sem o acesso / ERP sem o módulo: tenta de novo a cada 15 min (sem perder nada). */
const NO_ACCESS_WAIT_MS = 15 * 60_000;
/** O ERP aceita no máximo 30 dias de resposta/espera. */
const MAX_SECONDS = 30 * 86_400;
export const GAMIFICATION_RETENTION_DAYS = 90;

export const ERP_RESULT_STATUSES = [
  "APLICADO", "DUPLICADO", "SEM_USUARIO", "REGRA_DESLIGADA", "FORA_DO_PRAZO", "INVALIDO", "IGNORADO",
] as const;
export type ErpResultStatus = typeof ERP_RESULT_STATUSES[number];

// ─── Funções puras ──────────────────────────────────────────────────────────

const EVENT_ID_RE = /^[\w.:-]{1,120}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidEventId = (id: string) => EVENT_ID_RE.test(id);
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const firstResponseEventId = (conversationId: number, messageId: number) => `conv-${conversationId}:first-response:${messageId}`;
export const slaEventId = (conversationId: number, waitingSince: Date) => `conv-${conversationId}:sla:${Math.floor(waitingSince.getTime() / 1000)}`;
export const convertedEventId = (saleId: string) => `sale-${saleId.toLowerCase()}:converted`;
export const conversationRef = (conversationId: number | string) => `conv-${conversationId}`;

export function clampSeconds(ms: number): number {
  return Math.min(MAX_SECONDS, Math.max(0, Math.round(ms / 1000)));
}

/** Status do ERP → o que fazer com a linha da fila: "sent" (pronto) ou "failed" (não adianta mandar de novo). */
export function outcomeForErpStatus(status: string | undefined): "sent" | "failed" | "retry" {
  if (!status) return "retry";
  if (status === "INVALIDO") return "failed";
  return (ERP_RESULT_STATUSES as readonly string[]).includes(status) ? "sent" : "retry";
}

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)]!;
}

/** "ERP respondeu 403: ..." → 403 (erpFetch joga o status na mensagem). */
export function httpStatusOf(err: unknown): number | null {
  const m = /ERP respondeu (\d{3})/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

/** Mensagem clara (para a tela) a partir do erro da chamada ao ERP. */
export function describeGamificationError(err: unknown): string {
  const status = httpStatusOf(err);
  if (status === 401) return "O ERP recusou a chave (401). Confira a chave salva no cartão do ERP (aba Conexões).";
  if (status === 403) {
    return "A chave do ERP não tem o acesso \"Eventos de atendimento (gamificação)\" (ou o módulo Metas e Performance está desligado no ERP). "
      + "No ERP: Auxiliares › Integrações › Gerar chave, marque esse acesso junto com os que já usa e cole a chave nova aqui em \"Trocar chave\".";
  }
  if (status === 429) return "O ERP pediu para esperar (muitas chamadas). Tenta de novo sozinho.";
  if (status === 400) return `O ERP recusou o formato dos eventos (400): ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  if (status != null) return `O ERP respondeu ${status}. Tenta de novo sozinho.`;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("demorou") || (err as Error)?.name === "TimeoutError"
    ? "O ERP demorou demais para responder. Tenta de novo sozinho."
    : `Não conectou no ERP: ${msg.slice(0, 160)}. Tenta de novo sozinho.`;
}

/** Confere o item antes de enfileirar — o ERP recusaria o lote inteiro (400) por um item torto. */
export function validItem(item: ErpGamificationItem): boolean {
  if (!isValidEventId(item.eventId)) return false;
  if (!item.agent?.externalId || item.agent.externalId.length > 120) return false;
  if (item.agent.email && (item.agent.email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.agent.email))) return false;
  if (Number.isNaN(Date.parse(item.occurredAt))) return false;
  if (item.storeId !== undefined && !isUuid(item.storeId)) return false;
  if (item.type === "CONVERSATION_FIRST_RESPONSE") return Number.isInteger(item.responseSeconds) && item.responseSeconds! >= 0 && item.responseSeconds! <= MAX_SECONDS;
  if (item.type === "CONVERSATION_CONVERTED") return isUuid(item.saleId) || isUuid(item.quoteId);
  if (item.type === "CONVERSATION_UNANSWERED_SLA") return item.waitingSeconds === undefined || (Number.isInteger(item.waitingSeconds) && item.waitingSeconds >= 0 && item.waitingSeconds <= MAX_SECONDS);
  return false;
}

// ─── Banco: leitura auxiliar ────────────────────────────────────────────────

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];
const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/** Limite do alarme "sem resposta" da Central (Configurar alerta). Padrão 5 min. */
export async function unansweredAlertMinutes(tenantId: number): Promise<number> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, "alert_unanswered_minutes"))).limit(1);
  return Math.max(1, parseInt(row?.value ?? "5", 10) || 5);
}

/** Loja do ERP de cada loja/linha daqui (para o storeId opcional do evento). */
export async function storeLinkMaps(tenantId: number) {
  const links = await db.select().from(erpStoreLinksTable).where(eq(erpStoreLinksTable.tenantId, tenantId));
  const byStore = new Map<string, string>();
  const byLine = new Map<string, string>();
  for (const l of links) (l.kind === "store" ? byStore : byLine).set(l.crmRef, l.erpStoreId);
  return { byStore, byLine };
}

export function erpStoreFor(
  maps: { byStore: Map<string, string>; byLine: Map<string, string> },
  conv: { storeIds: (number | null | undefined)[]; lineRef: string | null },
): string | undefined {
  for (const s of conv.storeIds) {
    if (s != null && maps.byStore.has(String(s))) return maps.byStore.get(String(s));
  }
  if (conv.lineRef && maps.byLine.has(conv.lineRef)) return maps.byLine.get(conv.lineRef);
  return undefined;
}

async function usersById(tenantId: number, ids: number[]) {
  if (!ids.length) return new Map<number, { id: number; email: string; storeId: number | null }>();
  const users = await db.select({ id: usersTable.id, email: usersTable.email, storeId: usersTable.storeId })
    .from(usersTable).where(and(eq(usersTable.tenantId, tenantId), inArray(usersTable.id, ids)));
  return new Map(users.map((u) => [u.id, u]));
}

function agentOf(u: { id: number; email: string } | undefined): ErpGamificationItem["agent"] | null {
  if (!u) return null;
  const email = (u.email ?? "").trim().toLowerCase();
  return { externalId: String(u.id), ...(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 200 ? { email } : {}) };
}

/** Grava na fila (o mesmo eventId nunca entra duas vezes). Devolve quantos entraram. */
export async function enqueueGamificationEvents(
  tenantId: number,
  events: { item: ErpGamificationItem; conversationId: number | null; agentUserId: number | null }[],
): Promise<number> {
  const values = events.filter((e) => validItem(e.item)).map((e) => ({
    tenantId,
    eventId: e.item.eventId,
    type: e.item.type,
    conversationId: e.conversationId,
    agentUserId: e.agentUserId,
    occurredAt: new Date(e.item.occurredAt),
    payload: e.item,
  }));
  let n = 0;
  for (let i = 0; i < values.length; i += 500) {
    const inserted = await db.insert(erpGamificationEventsTable).values(values.slice(i, i + 500))
      .onConflictDoNothing().returning({ id: erpGamificationEventsTable.id });
    n += inserted.length;
  }
  return n;
}

// ─── 1) Primeira resposta ───────────────────────────────────────────────────

type FirstResponseRow = {
  id: number;
  conversation_id: number;
  sender_id: number;
  created_at: Date | string;
  started_at: Date | string | null;
  turn_start: Date | string | null;
  answered_before: boolean;
  skip: boolean;
  store_id: number | null;
  target_store_id: number | null;
  line_ref: string;
};

/**
 * Olha as mensagens de atendente depois do cursor e devolve os eventos de
 * primeira resposta + o cursor novo. Ignora: grupo/comunidade, linha
 * interna, mensagem que não responde o cliente (o cliente não tinha falado
 * por último — ex.: atendimento ativo), atendimento que começou antes de
 * ligar a pontuação, e qualquer resposta que não seja a primeira do atendimento.
 */
export async function collectFirstResponses(tenantId: number, cursor: number, since: Date, limit = SCAN_LIMIT) {
  const outboundHuman = sql`p.direction = 'outbound' AND p.sender_id IS NOT NULL AND p.type NOT IN ('note', 'system') AND p.status <> 'failed'`;
  const result = await db.execute(sql`
    select t.*,
      exists(
        select 1 from messages p
        where p.tenant_id = ${tenantId} and p.conversation_id = t.conversation_id and ${outboundHuman}
          and p.id < t.id and t.started_at is not null and p.created_at >= t.started_at
      ) as answered_before,
      (
        select min(p.created_at) from messages p
        where p.tenant_id = ${tenantId} and p.conversation_id = t.conversation_id and p.direction = 'inbound'
          and p.id < t.id and p.type NOT IN ('note', 'system')
          and p.id > coalesce((
            select max(q.id) from messages q
            where q.tenant_id = ${tenantId} and q.conversation_id = t.conversation_id and q.direction = 'outbound'
              and q.type NOT IN ('note', 'system') and q.id < t.id
          ), 0)
      ) as turn_start
    from (
      select m.id, m.conversation_id, m.sender_id, m.created_at,
        c.store_id, c.target_store_id,
        (case when c.channel = 'instagram' then 'instagram' else c.session_key end) as line_ref,
        (c.is_community or c.phone like '%@g.us' or c.phone like '%@newsletter' or coalesce(ws.line_type, 'varejo') = 'interna') as skip,
        greatest(
          case when c.attendance_started_at <= m.created_at then c.attendance_started_at end,
          (select max(e.started_at) from attendance_start_events e
            where e.tenant_id = ${tenantId} and e.conversation_id = m.conversation_id and e.started_at <= m.created_at)
        ) as started_at
      from messages m
      join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
      left join whatsapp_sessions ws on ws.tenant_id = c.tenant_id and ws.session_key = c.session_key and c.channel <> 'instagram'
      where m.tenant_id = ${tenantId} and m.id > ${cursor}
        and m.direction = 'outbound' and m.sender_id is not null and m.type NOT IN ('note', 'system') and m.status <> 'failed'
      order by m.id
      limit ${limit}
    ) t
    order by t.id
  `);
  const rows = rowsOf<FirstResponseRow>(result);
  if (!rows.length) return { events: [] as { item: ErpGamificationItem; conversationId: number; agentUserId: number }[], next: cursor, scanned: 0 };
  const users = await usersById(tenantId, [...new Set(rows.map((r) => r.sender_id))]);
  const maps = await storeLinkMaps(tenantId);
  const events: { item: ErpGamificationItem; conversationId: number; agentUserId: number }[] = [];
  for (const r of rows) {
    if (r.skip || r.answered_before || r.started_at == null || r.turn_start == null) continue;
    const started = toDate(r.started_at);
    if (started.getTime() < since.getTime()) continue;
    const sentAt = toDate(r.created_at);
    const waitStart = Math.max(started.getTime(), toDate(r.turn_start).getTime());
    const agent = agentOf(users.get(r.sender_id));
    if (!agent) continue;
    const storeId = erpStoreFor(maps, { storeIds: [r.target_store_id, r.store_id, users.get(r.sender_id)?.storeId], lineRef: r.line_ref });
    events.push({
      conversationId: r.conversation_id,
      agentUserId: r.sender_id,
      item: {
        eventId: firstResponseEventId(r.conversation_id, r.id),
        type: "CONVERSATION_FIRST_RESPONSE",
        occurredAt: sentAt.toISOString(),
        agent,
        conversationId: conversationRef(r.conversation_id),
        ...(storeId ? { storeId } : {}),
        responseSeconds: clampSeconds(sentAt.getTime() - waitStart),
      },
    });
  }
  return { events, next: rows[rows.length - 1]!.id, scanned: rows.length };
}

// ─── 2) Sem resposta no prazo ───────────────────────────────────────────────

type SlaRow = {
  id: number;
  assignee_id: number;
  waiting_since: Date | string;
  store_id: number | null;
  target_store_id: number | null;
  line_ref: string;
};

/**
 * Conversas com responsável em que a vez é nossa (mesma regra da aba
 * "Responder agora" — "Não precisa responder" e "Retomar depois" valem) há
 * mais que o limite do alarme. Um evento por espera (o id leva a hora em que
 * o cliente ficou esperando): responder e o cliente escrever de novo abre outra.
 */
export async function collectUnansweredSla(tenantId: number, since: Date, minutes: number, now = new Date()) {
  const lastAt = sql`coalesce(c.last_message_at, 'epoch'::timestamptz)`;
  const snoozeActive = sql`(c.snooze_until IS NOT NULL AND c.snooze_set_at IS NOT NULL AND c.snooze_set_at >= ${lastAt})`;
  const needsReply = sql`(CASE WHEN ${snoozeActive} THEN c.snooze_until <= ${now.toISOString()}::timestamptz
    ELSE (c.last_message_direction = 'inbound' AND c.last_message_at IS NOT NULL
          AND (c.reply_dismissed_at IS NULL OR c.reply_dismissed_at < c.last_message_at)) END)`;
  const waitingSince = sql`(CASE WHEN ${snoozeActive} THEN c.snooze_until ELSE c.last_message_at END)`;
  const cut = new Date(now.getTime() - minutes * 60_000);
  const result = await db.execute(sql`
    select c.id, c.assignee_id, ${waitingSince} as waiting_since, c.store_id, c.target_store_id,
      (case when c.channel = 'instagram' then 'instagram' else c.session_key end) as line_ref
    from conversations c
    left join whatsapp_sessions ws on ws.tenant_id = c.tenant_id and ws.session_key = c.session_key and c.channel <> 'instagram'
    where c.tenant_id = ${tenantId}
      and c.assignee_id is not null and c.status not in ('resolved', 'archived') and c.is_archived = false
      and ${needsReply}
      and ${waitingSince} <= ${cut.toISOString()}::timestamptz
      and ${waitingSince} >= ${since.toISOString()}::timestamptz
      and c.is_community = false and c.phone not like '%@g.us' and c.phone not like '%@newsletter'
      and coalesce(ws.line_type, 'varejo') <> 'interna'
    order by c.id
    limit ${SCAN_LIMIT}
  `);
  const rows = rowsOf<SlaRow>(result);
  if (!rows.length) return [];
  const users = await usersById(tenantId, [...new Set(rows.map((r) => r.assignee_id))]);
  const maps = await storeLinkMaps(tenantId);
  const events: { item: ErpGamificationItem; conversationId: number; agentUserId: number }[] = [];
  for (const r of rows) {
    const agent = agentOf(users.get(r.assignee_id));
    if (!agent) continue;
    const ws = toDate(r.waiting_since);
    const storeId = erpStoreFor(maps, { storeIds: [r.target_store_id, r.store_id, users.get(r.assignee_id)?.storeId], lineRef: r.line_ref });
    events.push({
      conversationId: r.id,
      agentUserId: r.assignee_id,
      item: {
        eventId: slaEventId(r.id, ws),
        type: "CONVERSATION_UNANSWERED_SLA",
        occurredAt: new Date(ws.getTime() + minutes * 60_000).toISOString(),
        agent,
        conversationId: conversationRef(r.id),
        ...(storeId ? { storeId } : {}),
        waitingSeconds: clampSeconds(now.getTime() - ws.getTime()),
      },
    });
  }
  return events;
}

// ─── 3) Conversa que virou venda (lida do ERP) ──────────────────────────────

export interface AttributedSale {
  saleId: string;
  storeId: string | null;
  attributedAt: string;
  attendantExternalId: string | null;
  conversationExternalId: string | null;
}

/** Vendas atribuídas pelo ERP → eventos (só atendente que existe nesta loja do CRM). */
export async function convertedEventsFromSales(tenantId: number, sales: AttributedSale[]) {
  const ids = [...new Set(sales.map((s) => Number(s.attendantExternalId)).filter((n) => Number.isInteger(n) && n > 0))];
  const users = await usersById(tenantId, ids);
  const events: { item: ErpGamificationItem; conversationId: number | null; agentUserId: number }[] = [];
  for (const s of sales) {
    if (!isUuid(s.saleId)) continue;
    const uid = Number(s.attendantExternalId);
    const agent = agentOf(users.get(uid));
    if (!agent) continue;
    const convId = s.conversationExternalId && /^\d{1,12}$/.test(s.conversationExternalId) ? Number(s.conversationExternalId) : null;
    events.push({
      conversationId: convId,
      agentUserId: uid,
      item: {
        eventId: convertedEventId(s.saleId),
        type: "CONVERSATION_CONVERTED",
        occurredAt: new Date(Number.isNaN(Date.parse(s.attributedAt)) ? Date.now() : Date.parse(s.attributedAt)).toISOString(),
        agent,
        ...(convId != null ? { conversationId: conversationRef(convId) } : {}),
        ...(isUuid(s.storeId) ? { storeId: s.storeId } : {}),
        saleId: s.saleId,
      },
    });
  }
  return events;
}

// ─── Envio ──────────────────────────────────────────────────────────────────

interface ErpEventsResponse {
  version?: number;
  received?: number;
  applied?: number;
  results?: { eventId: string; status: string; points?: number; message?: string }[];
}

export interface SendResult { sent: number; applied: number; failed: number; retry: number; error: string | null }

/** Manda um lote (até 200) da fila desta loja. */
export async function sendGamificationBatch(tenantId: number, cred: { baseUrl: string; apiKey: string }, now = new Date()): Promise<SendResult & { claimed: number }> {
  const out = { sent: 0, applied: 0, failed: 0, retry: 0, error: null as string | null, claimed: 0 };
  const due = await db.select({ id: erpGamificationEventsTable.id }).from(erpGamificationEventsTable)
    .where(and(
      eq(erpGamificationEventsTable.tenantId, tenantId),
      eq(erpGamificationEventsTable.status, "pending"),
      // O que acabou de entrar na fila (default now() do banco) também vale.
      lte(erpGamificationEventsTable.nextAttemptAt, new Date(Math.max(now.getTime(), Date.now()))),
    ))
    .orderBy(asc(erpGamificationEventsTable.id))
    .limit(MAX_ITEMS_PER_CALL);
  if (!due.length) return out;
  // Reivindica (um processo por vez); next_attempt_at vira "reivindicada em".
  const rows = await db.update(erpGamificationEventsTable)
    .set({ status: "processing", nextAttemptAt: now })
    .where(and(inArray(erpGamificationEventsTable.id, due.map((d) => d.id)), eq(erpGamificationEventsTable.status, "pending")))
    .returning();
  out.claimed = rows.length;
  if (!rows.length) return out;
  let body: ErpEventsResponse;
  try {
    body = await erpFetch(cred.baseUrl, cred.apiKey, GAMIFICATION_PATH, {
      method: "POST",
      body: JSON.stringify({ version: 1, items: rows.map((r) => r.payload) }),
    }, 20_000) as ErpEventsResponse;
  } catch (err) {
    const status = httpStatusOf(err);
    const message = describeGamificationError(err);
    out.error = message;
    // 401/403: chave sem acesso — espera a chave nova (não conta tentativa).
    // 400: o ERP recusou o formato do lote — não adianta insistir.
    for (const r of rows) {
      const attempts = r.attempts + 1;
      const noAccess = status === 401 || status === 403;
      const final = status === 400 || (!noAccess && attempts >= MAX_ATTEMPTS);
      await db.update(erpGamificationEventsTable).set({
        status: final ? "failed" : "pending",
        attempts: noAccess ? r.attempts : attempts,
        lastError: message.slice(0, 500),
        nextAttemptAt: new Date(now.getTime() + (noAccess ? NO_ACCESS_WAIT_MS : backoffMs(attempts))),
      }).where(eq(erpGamificationEventsTable.id, r.id));
      if (final) out.failed++; else out.retry++;
    }
    return out;
  }
  const byId = new Map((body.results ?? []).map((x) => [x.eventId, x]));
  for (const r of rows) {
    const res = byId.get(r.eventId);
    const outcome = outcomeForErpStatus(res?.status);
    if (outcome === "retry") {
      const attempts = r.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await db.update(erpGamificationEventsTable).set({
        status: final ? "failed" : "pending", attempts,
        lastError: res ? `Resposta do ERP desconhecida: ${String(res.status).slice(0, 40)}` : "O ERP não devolveu este evento na resposta",
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      }).where(eq(erpGamificationEventsTable.id, r.id));
      if (final) out.failed++; else out.retry++;
      continue;
    }
    await db.update(erpGamificationEventsTable).set({
      status: outcome,
      erpStatus: res!.status,
      erpPoints: Number.isFinite(Number(res!.points)) ? Math.round(Number(res!.points)) : 0,
      erpMessage: res!.message ? String(res!.message).slice(0, 300) : null,
      lastError: null,
      sentAt: now,
      attempts: r.attempts + 1,
    }).where(eq(erpGamificationEventsTable.id, r.id));
    if (outcome === "sent") out.sent++; else out.failed++;
    if (res!.status === "APLICADO") out.applied++;
  }
  return out;
}

// ─── Rodada por loja ────────────────────────────────────────────────────────

export interface GamificationRunResult {
  enqueued: { firstResponse: number; sla: number; converted: number };
  sent: number;
  applied: number;
  failed: number;
  pending: number;
  error: string | null;
  salesError: string | null;
}

type IntegrationRow = typeof tenantErpIntegrationsTable.$inferSelect;

export function runTenantGamification(tenantId: number, now = new Date()): Promise<GamificationRunResult> {
  return withErpTenant(tenantId, () => runTenantGamificationInner(tenantId, now));
}

async function runTenantGamificationInner(tenantId: number, now: Date): Promise<GamificationRunResult> {
  const result: GamificationRunResult = {
    enqueued: { firstResponse: 0, sla: 0, converted: 0 }, sent: 0, applied: 0, failed: 0, pending: 0, error: null, salesError: null,
  };
  const [row] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  if (!row || !row.gamificationEnabled) return result;
  const integ: IntegrationRow = row;

  // Primeira rodada (ou religado): começa agora, sem histórico antigo.
  let since = integ.gamificationSince;
  let msgCursor = integ.gamificationMsgCursor;
  if (!since) {
    since = now;
    const [{ maxId } = { maxId: 0 }] = rowsOf<{ maxId: number | null }>(await db.execute(
      sql`select coalesce(max(id), 0)::int as "maxId" from messages where tenant_id = ${tenantId}`,
    ));
    msgCursor = Number(maxId ?? 0);
    await db.update(tenantErpIntegrationsTable)
      .set({ gamificationSince: since, gamificationMsgCursor: msgCursor, gamificationSalesCursor: null })
      .where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  }

  // 1) Primeira resposta (até 4 páginas por rodada).
  for (let page = 0; page < 4; page++) {
    const { events, next, scanned } = await collectFirstResponses(tenantId, msgCursor, since);
    if (events.length) result.enqueued.firstResponse += await enqueueGamificationEvents(tenantId, events);
    if (next !== msgCursor) {
      msgCursor = next;
      await db.update(tenantErpIntegrationsTable).set({ gamificationMsgCursor: msgCursor }).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
    }
    if (scanned < SCAN_LIMIT) break;
  }

  // 2) Sem resposta no prazo.
  const minutes = await unansweredAlertMinutes(tenantId);
  const sla = await collectUnansweredSla(tenantId, since, minutes, now);
  if (sla.length) result.enqueued.sla += await enqueueGamificationEvents(tenantId, sla);

  const cred = await erpCredentials(tenantId);
  if (!cred) {
    result.error = "Ligação com o ERP não configurada";
  } else {
    // 3) Vendas atribuídas pelo ERP (conversa que virou venda). Falha aqui não
    // impede o resto (ERP antigo sem a rota, chave sem "Vendas do atendimento").
    try {
      let cursor = integ.gamificationSalesCursor;
      for (let page = 0; page < 5; page++) {
        const qs = new URLSearchParams({ limit: String(MAX_ITEMS_PER_CALL) });
        if (cursor) qs.set("after", cursor); else qs.set("since", since.toISOString());
        const r = await erpFetch(cred.baseUrl, cred.apiKey, `${ATTRIBUTED_SALES_PATH}?${qs}`, undefined, 15_000) as { items?: AttributedSale[]; nextCursor?: string | null };
        const items = Array.isArray(r.items) ? r.items : [];
        const events = await convertedEventsFromSales(tenantId, items);
        if (events.length) result.enqueued.converted += await enqueueGamificationEvents(tenantId, events);
        const next = typeof r.nextCursor === "string" && r.nextCursor.length <= 200 ? r.nextCursor : null;
        if (next && next !== cursor) {
          cursor = next;
          await db.update(tenantErpIntegrationsTable).set({ gamificationSalesCursor: cursor }).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
        }
        if (items.length < MAX_ITEMS_PER_CALL || !next) break;
      }
    } catch (err) {
      const status = httpStatusOf(err);
      result.salesError = status === 403
        ? "Vendas que vieram do atendimento: a chave do ERP não tem o acesso \"Vendas do atendimento\"."
        : status === 404
          ? "Vendas que vieram do atendimento: o ERP ainda não tem a consulta das vendas atribuídas (atualize o ERP)."
          : `Vendas que vieram do atendimento: ${describeGamificationError(err)}`;
    }

    // 4) Envio da fila.
    for (let call = 0; call < CALLS_PER_TICK; call++) {
      const r = await sendGamificationBatch(tenantId, cred, now);
      result.sent += r.sent; result.applied += r.applied; result.failed += r.failed;
      if (r.error) { result.error = r.error; break; }
      if (r.claimed < MAX_ITEMS_PER_CALL) break;
    }
  }

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(erpGamificationEventsTable)
    .where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.status, "pending")));
  result.pending = Number(n);
  const lastError = [result.error, result.salesError].filter(Boolean).join(" · ") || null;
  await db.update(tenantErpIntegrationsTable)
    .set({ gamificationLastSyncAt: now, gamificationLastError: lastError?.slice(0, 600) ?? null })
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  return result;
}

let running = false;

/** Tick do agendador (a cada minuto): todas as lojas com o ERP ligado e a pontuação ligada. */
export async function runErpGamification(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Linhas presas em "processing" (processo caiu no meio) voltam para a fila.
    await db.update(erpGamificationEventsTable).set({ status: "pending" })
      .where(and(eq(erpGamificationEventsTable.status, "processing"), lte(erpGamificationEventsTable.nextAttemptAt, sql`now() - interval '10 minutes'`)));
    const tenants = await db.select({ tenantId: tenantErpIntegrationsTable.tenantId }).from(tenantErpIntegrationsTable)
      .where(eq(tenantErpIntegrationsTable.gamificationEnabled, true));
    for (const t of tenants) {
      try {
        await runTenantGamification(t.tenantId);
      } catch (err) {
        logger.warn({ err, tenantId: t.tenantId }, "Pontuação do atendimento (ERP): rodada falhou");
      }
    }
  } finally {
    running = false;
  }
}

export async function cleanupGamificationEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - GAMIFICATION_RETENTION_DAYS * 86_400_000);
  const res = await db.delete(erpGamificationEventsTable)
    .where(and(lt(erpGamificationEventsTable.createdAt, cutoff), inArray(erpGamificationEventsTable.status, ["sent", "failed"])))
    .returning({ id: erpGamificationEventsTable.id });
  return res.length;
}

// ─── Tela (Trocas com o ERP / cartão do ERP) ────────────────────────────────

export async function gamificationOverview(tenantId: number, limit = 50) {
  const t = erpGamificationEventsTable;
  const [row] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  const [byStatus, byErp, recent] = await Promise.all([
    db.select({ status: t.status, n: count() }).from(t).where(eq(t.tenantId, tenantId)).groupBy(t.status),
    db.select({ erpStatus: t.erpStatus, n: count(), points: sql<string>`coalesce(sum(${t.erpPoints}), 0)` }).from(t)
      .where(and(eq(t.tenantId, tenantId), isNotNull(t.erpStatus), sql`${t.sentAt} >= now() - interval '30 days'`))
      .groupBy(t.erpStatus),
    db.select({
      id: t.id, eventId: t.eventId, type: t.type, status: t.status, erpStatus: t.erpStatus, erpPoints: t.erpPoints,
      erpMessage: t.erpMessage, lastError: t.lastError, attempts: t.attempts, occurredAt: t.occurredAt, sentAt: t.sentAt,
      conversationId: t.conversationId, agentName: usersTable.name,
    }).from(t)
      .leftJoin(usersTable, and(eq(usersTable.id, t.agentUserId), eq(usersTable.tenantId, t.tenantId)))
      .where(eq(t.tenantId, tenantId))
      .orderBy(desc(t.id))
      .limit(limit),
  ]);
  const queue = { pending: 0, processing: 0, sent: 0, failed: 0 };
  for (const r of byStatus) if (r.status in queue) queue[r.status as keyof typeof queue] = Number(r.n);
  const erp: Record<string, { count: number; points: number }> = {};
  for (const r of byErp) if (r.erpStatus) erp[r.erpStatus] = { count: Number(r.n), points: Number(r.points) };
  return {
    configured: !!row,
    enabled: row?.gamificationEnabled ?? false,
    since: row?.gamificationSince ?? null,
    lastSyncAt: row?.gamificationLastSyncAt ?? null,
    lastError: row?.gamificationLastError ?? null,
    queue,
    erpLast30Days: erp,
    recent,
  };
}

/** Linhas que falharam voltam para a fila (tentativas zeradas). */
export async function retryFailedGamification(tenantId: number): Promise<number> {
  const rows = await db.update(erpGamificationEventsTable)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(and(eq(erpGamificationEventsTable.tenantId, tenantId), eq(erpGamificationEventsTable.status, "failed")))
    .returning({ id: erpGamificationEventsTable.id });
  return rows.length;
}
