// "Clientes esperando resposta" na TV de cada loja do ERP Prumo (27/10/2026).
//
// O Modo TV do ERP mostra, na TV da loja, quem está esperando resposta no
// CRM. O ERP não guarda endereço nem chave do CRM (toda a integração é o CRM
// chamando o ERP com a chave X-Api-Key), então o CRM MANDA a fila: a cada
// minuto, um retrato por loja do ERP (POST /integrations/crm-waiting/v1/snapshot,
// acesso "Fila de espera do atendimento (TV da loja)"). O ERP guarda o último
// retrato e a TV conta o tempo a partir dele; sem retrato novo em alguns
// minutos (CRM fora do ar), a TV mostra o estado "Ligue a integração do CRM".
//
// Loja de cada conversa: a loja que o robô escolheu, a loja de quem atende ou
// a do responsável, ligada à loja do ERP em "Lojas no ERP"; sem ligação da
// loja, vale a ligação da linha de WhatsApp (ou do Instagram).
//
// LGPD: vai só o primeiro nome + inicial do sobrenome ("Ana S."), o canal, o
// setor (como assunto curto) e os segundos de espera. Nunca celular, foto ou
// texto de mensagem.
import { eq, sql } from "drizzle-orm";
import { db, erpStoreLinksTable, tenantErpIntegrationsTable } from "@workspace/db";
import { erpCredentials } from "./erpSalesSync";
import { erpFetch } from "./erpOsMessages";
import { withErpTenant } from "./erpExchanges";
import { erpStoreFor, storeLinkMaps, unansweredAlertMinutes, httpStatusOf } from "./erpGamification";
import { logger } from "./logger";

export const TV_SNAPSHOT_PATH = "/integrations/crm-waiting/v1/snapshot";
/** Conversas por loja no retrato (a TV mostra só as primeiras). */
export const MAX_PER_STORE = 20;
/** Espera mais antiga que isso não entra (conversa esquecida há dias não é "esperando agora"). */
export const MAX_WAIT_HOURS = 72;

/** "ana maria souza" → "Ana S."; só número/emoji → "Cliente". */
export function shortCustomerName(raw: string | null | undefined): string {
  const words = String(raw ?? "")
    .normalize("NFC")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}'-]/gu, ""))
    .filter((w) => /\p{L}/u.test(w));
  if (!words.length) return "Cliente";
  const cap = (w: string) => w.charAt(0).toLocaleUpperCase("pt-BR") + w.slice(1).toLocaleLowerCase("pt-BR");
  const first = cap(words[0]!).slice(0, 20);
  const last = words.length > 1 ? words[words.length - 1]! : null;
  return last ? `${first} ${last.charAt(0).toLocaleUpperCase("pt-BR")}.` : first;
}

export interface TvConversation {
  conversationId: string;
  customer: string;
  channel: "whatsapp" | "instagram";
  topic?: string;
  waitingSeconds: number;
}

export interface TvStoreSnapshot {
  storeId: string;
  waitingCount: number;
  lateCount: number;
  conversations: TvConversation[];
}

type WaitingRow = {
  id: number;
  name: string | null;
  channel: string;
  waiting_since: Date | string;
  store_id: number | null;
  target_store_id: number | null;
  assignee_store_id: number | null;
  line_ref: string;
  sector_name: string | null;
};

/**
 * Retrato por loja do ERP. Entra toda conversa em aberto em que a vez é nossa
 * (com ou sem responsável — fila também é cliente esperando), fora grupo,
 * comunidade e linha interna. Lojas do ERP ligadas e sem ninguém esperando
 * vão com a lista vazia (a TV mostra "ninguém esperando").
 */
export async function buildTvSnapshot(tenantId: number, now = new Date()): Promise<TvStoreSnapshot[]> {
  const maps = await storeLinkMaps(tenantId);
  const erpStores = new Set([...maps.byStore.values(), ...maps.byLine.values()]);
  if (!erpStores.size) return [];
  const minutes = await unansweredAlertMinutes(tenantId);
  const nowIso = now.toISOString();
  const lastAt = sql`coalesce(c.last_message_at, 'epoch'::timestamptz)`;
  const snoozeActive = sql`(c.snooze_until IS NOT NULL AND c.snooze_set_at IS NOT NULL AND c.snooze_set_at >= ${lastAt})`;
  const needsReply = sql`(CASE WHEN ${snoozeActive} THEN c.snooze_until <= ${nowIso}::timestamptz
    ELSE (c.last_message_direction = 'inbound' AND c.last_message_at IS NOT NULL
          AND (c.reply_dismissed_at IS NULL OR c.reply_dismissed_at < c.last_message_at)) END)`;
  const waitingSince = sql`(CASE WHEN ${snoozeActive} THEN c.snooze_until ELSE c.last_message_at END)`;
  const oldest = new Date(now.getTime() - MAX_WAIT_HOURS * 3_600_000).toISOString();
  const result = await db.execute(sql`
    select c.id, c.name, c.channel, ${waitingSince} as waiting_since, c.store_id, c.target_store_id,
      u.store_id as assignee_store_id, s.name as sector_name,
      (case when c.channel = 'instagram' then 'instagram' else c.session_key end) as line_ref
    from conversations c
    left join whatsapp_sessions ws on ws.tenant_id = c.tenant_id and ws.session_key = c.session_key and c.channel <> 'instagram'
    left join users u on u.id = c.assignee_id and u.tenant_id = c.tenant_id
    left join sectors s on s.id = c.sector_id and s.tenant_id = c.tenant_id
    where c.tenant_id = ${tenantId}
      and c.status not in ('resolved', 'archived') and c.is_archived = false
      and ${needsReply}
      and ${waitingSince} >= ${oldest}::timestamptz
      and c.is_community = false and c.phone not like '%@g.us' and c.phone not like '%@newsletter'
      and coalesce(ws.line_type, 'varejo') <> 'interna'
    order by ${waitingSince} asc, c.id asc
    limit 2000
  `);
  const rows = ((result as unknown as { rows?: WaitingRow[] }).rows ?? (result as unknown as WaitingRow[])) as WaitingRow[];
  const byStore = new Map<string, TvStoreSnapshot>();
  for (const id of erpStores) byStore.set(id, { storeId: id, waitingCount: 0, lateCount: 0, conversations: [] });
  for (const r of rows) {
    const erpStoreId = erpStoreFor(maps, { storeIds: [r.target_store_id, r.store_id, r.assignee_store_id], lineRef: r.line_ref });
    if (!erpStoreId) continue;
    const snap = byStore.get(erpStoreId)!;
    const since = r.waiting_since instanceof Date ? r.waiting_since : new Date(r.waiting_since);
    const waitingSeconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
    snap.waitingCount += 1;
    if (waitingSeconds >= minutes * 60) snap.lateCount += 1;
    if (snap.conversations.length < MAX_PER_STORE) {
      const topic = (r.sector_name ?? "").trim().slice(0, 40);
      snap.conversations.push({
        conversationId: `conv-${r.id}`,
        customer: shortCustomerName(r.name),
        channel: r.channel === "instagram" ? "instagram" : "whatsapp",
        ...(topic ? { topic } : {}),
        waitingSeconds,
      });
    }
  }
  return [...byStore.values()];
}

export function describeTvError(err: unknown): string {
  const status = httpStatusOf(err);
  if (status === 401) return "O ERP recusou a chave (401). Confira a chave salva no cartão do ERP.";
  if (status === 403) {
    return "A chave do ERP não tem o acesso \"Fila de espera do atendimento (TV da loja)\". "
      + "No ERP: Auxiliares › Integrações › Gerar chave, marque esse acesso junto com os que já usa e cole a chave nova aqui em \"Trocar chave\".";
  }
  if (status === 404) return "O ERP ainda não recebe a fila da TV (atualize o ERP).";
  if (status != null) return `O ERP respondeu ${status}. Tenta de novo no próximo minuto.`;
  return `Não conectou no ERP: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`;
}

export interface TvPushResult { stores: number; waiting: number; error: string | null; skipped?: string }

export function pushTvSnapshot(tenantId: number, now = new Date()): Promise<TvPushResult> {
  return withErpTenant(tenantId, () => pushTvSnapshotInner(tenantId, now));
}

async function pushTvSnapshotInner(tenantId: number, now: Date): Promise<TvPushResult> {
  const [row] = await db.select({ enabled: tenantErpIntegrationsTable.tvWaitingEnabled })
    .from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  if (!row?.enabled) return { stores: 0, waiting: 0, error: null, skipped: "desligado" };
  const stores = await buildTvSnapshot(tenantId, now);
  if (!stores.length) {
    await db.update(tenantErpIntegrationsTable)
      .set({ tvWaitingLastError: "Ligue as lojas do CRM às lojas do ERP (cartão do ERP › Lojas no ERP)." })
      .where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
    return { stores: 0, waiting: 0, error: null, skipped: "sem lojas ligadas" };
  }
  const cred = await erpCredentials(tenantId);
  if (!cred) return { stores: 0, waiting: 0, error: "Ligação com o ERP não configurada" };
  const waiting = stores.reduce((n, s) => n + s.waitingCount, 0);
  try {
    await erpFetch(cred.baseUrl, cred.apiKey, TV_SNAPSHOT_PATH, {
      method: "POST",
      body: JSON.stringify({ version: 1, generatedAt: now.toISOString(), items: stores }),
    }, 10_000);
    await db.update(tenantErpIntegrationsTable).set({ tvWaitingLastPushAt: now, tvWaitingLastError: null })
      .where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
    return { stores: stores.length, waiting, error: null };
  } catch (err) {
    const error = describeTvError(err);
    await db.update(tenantErpIntegrationsTable).set({ tvWaitingLastError: error.slice(0, 600) })
      .where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
    return { stores: stores.length, waiting, error };
  }
}

let running = false;

/** Tick do agendador (a cada minuto). */
export async function runErpTvWaiting(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const tenants = await db.selectDistinct({ tenantId: tenantErpIntegrationsTable.tenantId })
      .from(tenantErpIntegrationsTable)
      .innerJoin(erpStoreLinksTable, eq(erpStoreLinksTable.tenantId, tenantErpIntegrationsTable.tenantId))
      .where(eq(tenantErpIntegrationsTable.tvWaitingEnabled, true));
    for (const t of tenants) {
      try {
        await pushTvSnapshot(t.tenantId);
      } catch (err) {
        logger.warn({ err, tenantId: t.tenantId }, "TV do ERP: envio da fila falhou");
      }
    }
  } finally {
    running = false;
  }
}
