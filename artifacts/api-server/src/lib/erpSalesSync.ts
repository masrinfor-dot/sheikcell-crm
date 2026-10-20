// Vendas que vieram do atendimento (19/10/2026): o CRM manda ao ERP Prumo,
// de tempos em tempos, os atendimentos — telefone do cliente, atendente,
// setor, loja, data do último contato e o id da conversa — e a lista de
// atendentes. Ao concluir uma venda para um cliente atendido nos últimos N
// dias (configurado no ERP, padrão 15), o ERP marca a venda com o atendente
// mais recente; o vendedor pode marcar/corrigir no PDV (o manual vence).
//
// Incremental: cursor (cursorAt, cursorId) na ordem do último movimento da
// conversa (mensagem ou mudança de responsável). Primeira rodada: últimos
// 60 dias. O ERP é idempotente (uma linha por conversa; o mesmo ou um mais
// antigo não muda nada). Como nas mensagens das OS, o ERP nunca chama o CRM.
import { and, eq, inArray, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db, erpSalesSyncTable, tenantErpIntegrationsTable, usersTable,
} from "@workspace/db";
import { decryptErpSecret } from "./erpCrypto";
import { erpFetch } from "./erpOsMessages";
import { withErpTenant } from "./erpExchanges";
import { logger } from "./logger";

export const SALES_HISTORY_DAYS = 60;
const BATCH = 200;
const CALLS_PER_RUN = 10;
const ATTENDANTS_EVERY_MS = 60 * 60_000;

export type AttendanceItem = {
  externalId: string;
  phone: string;
  customerName?: string;
  attendantExternalId: string;
  attendantName: string;
  attendantEmail?: string;
  sectorName?: string;
  storeName?: string;
  lastContactAt: string;
};

type Row = {
  id: number;
  phone: string;
  name: string | null;
  channel: string;
  is_community: boolean;
  attendant_id: number | null;
  sector_name: string | null;
  store_name: string | null;
  last_contact_at: Date | string;
  touched_at: Date | string;
};

/** Só dígitos do telefone; null se não for um celular/fixo com DDD. */
export function phoneForErp(phone: string | null | undefined): string | null {
  const raw = (phone ?? "").trim();
  if (!raw || raw.includes("@g.us") || raw.includes("@newsletter") || raw.includes("@lid")) return null;
  const d = raw.replace(/@.*$/, "").replace(/\D/g, "");
  if (d.length < 10 || d.length > 13) return null;
  return d;
}

const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/**
 * Próximo lote de conversas mexidas depois do cursor, já com o atendente
 * (o responsável atual ou, se a conversa já foi finalizada e perdeu o dono,
 * quem atendeu por último). Devolve os itens para o ERP e o cursor novo
 * (que avança mesmo nas conversas puladas: grupo, Instagram, sem atendente).
 */
export async function collectAttendances(
  tenantId: number,
  cursorAt: Date,
  cursorId: number,
  limit = BATCH,
): Promise<{ items: AttendanceItem[]; next: { at: Date; id: number } | null; scanned: number }> {
  const result = await db.execute(sql`
    select * from (
      select c.id, c.phone, c.name, c.channel, c.is_community,
        coalesce(c.assignee_id, l.attendant_id) as attendant_id,
        s.name as sector_name,
        st.name as store_name,
        coalesce(c.last_message_at, c.updated_at) as last_contact_at,
        date_trunc('milliseconds', greatest(c.updated_at, coalesce(c.last_message_at, c.updated_at))) as touched_at
      from conversations c
      left join lateral (
        select al.attendant_id, al.store_id from attendance_logs al
        where al.conversation_id = c.id and al.attendant_id is not null
        order by al.id desc limit 1
      ) l on true
      left join sectors s on s.id = c.sector_id
      left join stores st on st.id = coalesce(c.store_id, l.store_id)
      where c.tenant_id = ${tenantId}
    ) t
    where (t.touched_at, t.id) > (${cursorAt.toISOString()}::timestamptz, ${cursorId})
    order by t.touched_at, t.id
    limit ${limit}
  `);
  const rows = ((result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[])) as Row[];
  if (rows.length === 0) return { items: [], next: null, scanned: 0 };

  const userIds = [...new Set(rows.map((r) => r.attendant_id).filter((v): v is number => v != null))];
  const users = userIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, storeName: usersTable.storeName })
        .from(usersTable).where(and(eq(usersTable.tenantId, tenantId), inArray(usersTable.id, userIds)))
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const items: AttendanceItem[] = [];
  for (const r of rows) {
    if (r.is_community || r.channel === "instagram" || r.attendant_id == null) continue;
    const phone = phoneForErp(r.phone);
    const u = userMap.get(r.attendant_id);
    if (!phone || !u) continue;
    items.push({
      externalId: String(r.id),
      phone,
      customerName: r.name?.trim() || undefined,
      attendantExternalId: String(u.id),
      attendantName: u.name,
      attendantEmail: u.email || undefined,
      sectorName: r.sector_name ?? undefined,
      storeName: r.store_name ?? u.storeName ?? undefined,
      lastContactAt: toDate(r.last_contact_at).toISOString(),
    });
  }
  const last = rows[rows.length - 1]!;
  return { items, next: { at: toDate(last.touched_at), id: last.id }, scanned: rows.length };
}

/** Todos os atendentes da loja (para o vendedor escolher no PDV do ERP). */
export async function attendantsForErp(tenantId: number) {
  const users = await db.select({
    id: usersTable.id, name: usersTable.name, email: usersTable.email,
    storeName: usersTable.storeName, isActive: usersTable.isActive,
  }).from(usersTable).where(and(eq(usersTable.tenantId, tenantId), ne(usersTable.role, "superadmin")));
  return users.map((u) => ({
    externalId: String(u.id),
    name: u.name,
    email: u.email || undefined,
    storeName: u.storeName ?? undefined,
    active: u.isActive,
  }));
}

export interface SalesSyncResult {
  sent: number;
  scanned: number;
  calls: number;
  attendants: number | null;
  error: string | null;
}

async function ensureRow(tenantId: number) {
  await db.insert(erpSalesSyncTable).values({ tenantId }).onConflictDoNothing();
  const [row] = await db.select().from(erpSalesSyncTable).where(eq(erpSalesSyncTable.tenantId, tenantId)).limit(1);
  return row!;
}

/** Roda o envio de UMA loja (o scheduler chama para todas as ligadas). */
/** Roda dentro do contexto da loja: cada chamada ao ERP entra no histórico de trocas. */
export function syncTenantSales(tenantId: number, now = new Date(), maxCalls = CALLS_PER_RUN): Promise<SalesSyncResult> {
  return withErpTenant(tenantId, () => syncTenantSalesInner(tenantId, now, maxCalls));
}

async function syncTenantSalesInner(tenantId: number, now: Date, maxCalls: number): Promise<SalesSyncResult> {
  const result: SalesSyncResult = { sent: 0, scanned: 0, calls: 0, attendants: null, error: null };
  const [integ] = await db.select().from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  const state = await ensureRow(tenantId);
  if (!integ) {
    result.error = "Ligação com o ERP não configurada";
    await db.update(erpSalesSyncTable).set({ lastError: result.error, lastSyncAt: now }).where(eq(erpSalesSyncTable.tenantId, tenantId));
    return result;
  }
  let cursorAt = state.cursorAt ?? new Date(now.getTime() - SALES_HISTORY_DAYS * 86_400_000);
  let cursorId = state.cursorAt ? state.cursorId : 0;
  let sentCount = state.sentCount;
  let attendantsSyncedAt = state.attendantsSyncedAt;
  try {
    const apiKey = decryptErpSecret({ ciphertext: integ.encryptedApiKey, iv: integ.iv, authTag: integ.authTag, keyVersion: integ.keyVersion });
    // 1) Lista de atendentes (completa), no máximo 1x por hora.
    if (!attendantsSyncedAt || now.getTime() - attendantsSyncedAt.getTime() >= ATTENDANTS_EVERY_MS) {
      const list = await attendantsForErp(tenantId);
      await erpFetch(integ.baseUrl, apiKey, "/integrations/crm-attendance/attendants", {
        method: "POST", body: JSON.stringify({ items: list, full: true }),
      });
      result.attendants = list.length;
      attendantsSyncedAt = now;
      await db.update(erpSalesSyncTable).set({ attendantsSyncedAt }).where(eq(erpSalesSyncTable.tenantId, tenantId));
    }
    // 2) Atendimentos novos/mexidos desde o cursor.
    for (let call = 0; call < maxCalls; call++) {
      const { items, next, scanned } = await collectAttendances(tenantId, cursorAt, cursorId);
      if (!next) break;
      if (items.length) {
        await erpFetch(integ.baseUrl, apiKey, "/integrations/crm-attendance/attendances", {
          method: "POST", body: JSON.stringify({ items }),
        });
        result.calls += 1;
        result.sent += items.length;
        sentCount += items.length;
      }
      result.scanned += scanned;
      // Só avança depois do ERP aceitar (se cair, manda de novo na próxima).
      cursorAt = next.at;
      cursorId = next.id;
      await db.update(erpSalesSyncTable).set({ cursorAt, cursorId, sentCount }).where(eq(erpSalesSyncTable.tenantId, tenantId));
      if (scanned < BATCH) break;
    }
  } catch (err) {
    result.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.warn({ err, tenantId }, "ERP: falha ao mandar os atendimentos (vendas do atendimento)");
  }
  await db.update(erpSalesSyncTable).set({ lastSyncAt: now, lastError: result.error })
    .where(eq(erpSalesSyncTable.tenantId, tenantId));
  return result;
}

let running = false;

export async function runErpSalesSync(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await db.select({ tenantId: erpSalesSyncTable.tenantId }).from(erpSalesSyncTable)
      .where(eq(erpSalesSyncTable.enabled, true));
    for (const r of rows) {
      try {
        await syncTenantSales(r.tenantId);
      } catch (err) {
        logger.warn({ err, tenantId: r.tenantId }, "ERP: envio dos atendimentos falhou");
      }
    }
  } finally {
    running = false;
  }
}

/** Período em datas locais (America/Sao_Paulo) dos últimos `days` dias, para o ERP. */
export function erpPeriod(days: number, now = new Date()): { from: string; to: string } {
  const local = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  return { from: local(new Date(now.getTime() - days * 86_400_000)), to: local(now) };
}

/** Chave do ERP desta loja (ou null se não ligado). */
export async function erpCredentials(tenantId: number): Promise<{ baseUrl: string; apiKey: string } | null> {
  const [integ] = await db.select().from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  if (!integ) return null;
  try {
    return {
      baseUrl: integ.baseUrl,
      apiKey: decryptErpSecret({ ciphertext: integ.encryptedApiKey, iv: integ.iv, authTag: integ.authTag, keyVersion: integ.keyVersion }),
    };
  } catch {
    return null;
  }
}

export type ErpPurchase = {
  number: string;
  completedAt: string | null;
  total: number;
  storeName: string;
  items: string[];
  attendantName: string | null;
};

/** Últimas compras do cliente no ERP pelo telefone (ficha da conversa). */
/** Compras do cliente no ERP (dentro do contexto da loja, para o histórico de trocas). */
export function customerPurchasesFromErp(tenantId: number, phone: string): Promise<{
  available: boolean;
  customerName: string | null;
  sales: ErpPurchase[];
}> {
  return withErpTenant(tenantId, () => customerPurchasesFromErpInner(tenantId, phone));
}

async function customerPurchasesFromErpInner(tenantId: number, phone: string): Promise<{
  available: boolean;
  customerName: string | null;
  sales: ErpPurchase[];
}> {
  const empty = { available: false, customerName: null, sales: [] };
  const p = phoneForErp(phone);
  const cred = await erpCredentials(tenantId);
  if (!p || !cred) return empty;
  try {
    const r = await erpFetch(cred.baseUrl, cred.apiKey, `/integrations/sales/by-phone?phone=${encodeURIComponent(p)}&limit=5`,
      undefined, 10_000) as { customer: { name: string } | null; sales: ErpPurchase[] };
    return { available: true, customerName: r.customer?.name ?? null, sales: r.sales ?? [] };
  } catch {
    return empty;
  }
}
