// Pedidos de clientes sem estoque (16/10/2026): as conversas da linha de
// atacado do WhatsApp vão para a IA do ERP, que lista o que os clientes
// pediram, casa com o cadastro e confere o estoque. A lista fica no ERP, em
// Compras › Pedidos de clientes. Daqui só saem as mensagens DO CLIENTE
// (texto), com id e data — o ERP nunca duplica (idempotente por mensagem).
//
// Primeira rodada: últimos 90 dias de cada conversa da linha; depois, só o
// que chegou de novo (cursor por conversa em erp_demand_cursors). Roda a
// cada 30 min pelo scheduler ou na hora pelo botão "Enviar agora".
import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import {
  db, conversationsTable, erpDemandCursorsTable, messagesTable, tenantErpIntegrationsTable,
} from "@workspace/db";
import { decryptErpSecret } from "./erpCrypto";
import { erpFetch } from "./erpOsMessages";
import { logger } from "./logger";

export const DEMAND_HISTORY_DAYS = 90;
const CONVERSATIONS_PER_CALL = 20;
const MESSAGES_PER_CONVERSATION = 300;
const CALLS_PER_RUN = 5;
const MIN_TEXT = 3;

export type DemandMessage = { id: string; at: string; text: string };
export type DemandConversation = { externalId: string; customerName?: string; customerPhone?: string; messages: DemandMessage[] };

export interface DemandSyncResult {
  conversations: number;
  messages: number;
  requests: number;
  outOfStock: number;
  calls: number;
  error: string | null;
}

/** Mensagens que valem a pena mandar: texto do cliente, não vazio, sem mídia só. */
export function usefulText(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < MIN_TEXT) return null;
  if (/^(📷 foto|🎥 vídeo|🎤 áudio|📄 |🎵 áudio|\(anexo\))/i.test(t)) return null;
  return t.slice(0, 4000);
}

/** Lote de até N conversas com mensagens novas da linha de atacado. */
export async function collectBatch(
  tenantId: number,
  sessionKey: string,
  limit = CONVERSATIONS_PER_CALL,
  now = new Date(),
): Promise<{ batch: DemandConversation[]; cursors: Map<number, number> }> {
  const since = new Date(now.getTime() - DEMAND_HISTORY_DAYS * 24 * 3600_000);
  const convs = await db.select({
    id: conversationsTable.id, name: conversationsTable.name, phone: conversationsTable.phone,
    lastMessageAt: conversationsTable.lastMessageAt,
  }).from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.sessionKey, sessionKey), gte(conversationsTable.lastMessageAt, since)))
    .orderBy(asc(conversationsTable.lastMessageAt));
  if (convs.length === 0) return { batch: [], cursors: new Map() };
  const ids = convs.map((c) => c.id);
  const cursorRows = await db.select().from(erpDemandCursorsTable).where(inArray(erpDemandCursorsTable.conversationId, ids));
  const cursor = new Map(cursorRows.map((c) => [c.conversationId, c.lastMessageId]));

  const batch: DemandConversation[] = [];
  const cursors = new Map<number, number>();
  for (const c of convs) {
    if (batch.length >= limit) break;
    // Grupos/comunidades do WhatsApp não são clientes.
    if (c.phone.includes("@g.us")) continue;
    const last = cursor.get(c.id) ?? 0;
    const rows = await db.select({ id: messagesTable.id, content: messagesTable.content, createdAt: messagesTable.createdAt, type: messagesTable.type })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.conversationId, c.id),
        eq(messagesTable.direction, "inbound"),
        gt(messagesTable.id, last),
        // 1ª vez: só os últimos 90 dias; depois tudo que for novo.
        ...(last === 0 ? [gte(messagesTable.createdAt, since)] : []),
      ))
      .orderBy(asc(messagesTable.id))
      .limit(MESSAGES_PER_CONVERSATION);
    if (rows.length === 0) continue;
    const messages: DemandMessage[] = [];
    for (const m of rows) {
      const text = m.type === "text" || m.type === "doc" || m.type === "image" ? usefulText(m.content) : null;
      if (text) messages.push({ id: String(m.id), at: m.createdAt.toISOString(), text });
    }
    cursors.set(c.id, rows[rows.length - 1]!.id);
    if (messages.length === 0) continue; // só mídia/figurinha: avança o cursor sem mandar
    batch.push({
      externalId: String(c.id),
      customerName: c.name?.trim() || undefined,
      customerPhone: c.phone.replace(/@.*$/, "") || undefined,
      messages,
    });
  }
  return { batch, cursors };
}

async function saveCursors(tenantId: number, cursors: Map<number, number>): Promise<void> {
  for (const [conversationId, lastMessageId] of cursors) {
    await db.insert(erpDemandCursorsTable).values({ conversationId, tenantId, lastMessageId, syncedAt: new Date() })
      .onConflictDoUpdate({ target: erpDemandCursorsTable.conversationId, set: { lastMessageId, syncedAt: new Date() } });
  }
}

/** Quantas conversas ainda têm mensagem nova pra mandar (pra tela mostrar o andamento). */
export async function pendingConversations(tenantId: number, sessionKey: string): Promise<number> {
  const { batch } = await collectBatch(tenantId, sessionKey, 500);
  return batch.length;
}

/** Roda a sincronização de UMA loja. Devolve o resumo (o scheduler chama pra todas). */
export async function syncTenantDemand(tenantId: number, maxCalls = CALLS_PER_RUN): Promise<DemandSyncResult> {
  const result: DemandSyncResult = { conversations: 0, messages: 0, requests: 0, outOfStock: 0, calls: 0, error: null };
  const [integ] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  if (!integ || !integ.demandSyncEnabled || !integ.demandSessionKey) {
    result.error = "Ligação com o ERP ou linha de atacado não configurada";
    return result;
  }
  const apiKey = decryptErpSecret({ ciphertext: integ.encryptedApiKey, iv: integ.iv, authTag: integ.authTag, keyVersion: integ.keyVersion });
  try {
    for (let call = 0; call < maxCalls; call++) {
      const { batch, cursors } = await collectBatch(tenantId, integ.demandSessionKey);
      if (batch.length === 0) {
        // Só cursores (conversas sem texto): avança e para.
        if (cursors.size > 0) await saveCursors(tenantId, cursors);
        break;
      }
      const report = await erpFetch(integ.baseUrl, apiKey, "/integrations/customer-demand/conversations", {
        method: "POST",
        body: JSON.stringify({ source: "crm-atacado", conversations: batch }),
      }, 180_000) as { conversations: number; messages: number; requests: number; outOfStock: number; skipped?: { externalId: string; reason: string }[] };
      // Conversa que a IA não leu fica pra próxima rodada (cursor não avança).
      const skipped = new Set((report.skipped ?? []).map((s) => Number(s.externalId)));
      for (const id of skipped) cursors.delete(id);
      await saveCursors(tenantId, cursors);
      result.calls += 1;
      result.conversations += report.conversations ?? 0;
      result.messages += report.messages ?? 0;
      result.requests += report.requests ?? 0;
      result.outOfStock += report.outOfStock ?? 0;
      if (skipped.size > 0 && skipped.size === batch.length) {
        result.error = `A IA do ERP não leu as conversas: ${report.skipped?.[0]?.reason ?? "erro"}`;
        break;
      }
      if (batch.length < CONVERSATIONS_PER_CALL) break;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logger.warn({ err, tenantId }, "ERP: falha ao mandar as conversas de atacado");
  }
  const pending = result.error ? null : await pendingConversations(tenantId, integ.demandSessionKey).catch(() => null);
  await db.update(tenantErpIntegrationsTable).set({
    demandLastSyncAt: new Date(),
    demandLastError: result.error,
    demandSentCount: integ.demandSentCount + result.requests,
    ...(pending != null ? { demandPendingCount: pending } : {}),
    updatedAt: new Date(),
  }).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  return result;
}

export async function runErpDemandSync(): Promise<void> {
  const rows = await db.select({ tenantId: tenantErpIntegrationsTable.tenantId }).from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.demandSyncEnabled, true));
  for (const r of rows) {
    try {
      await syncTenantDemand(r.tenantId);
    } catch (err) {
      logger.warn({ err, tenantId: r.tenantId }, "ERP: sincronização de pedidos de atacado falhou");
    }
  }
}
