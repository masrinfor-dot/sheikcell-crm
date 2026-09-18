/**
 * "Pular fila" por palavra-chave (pedido 18/09: "como recebemos muitos
 * xerox impressão criar palavra chave por transferir atendimento para loja
 * adequada e pular a fila, e limitando finalizar o atendimento que pulou a
 * fila pra vir outro").
 *
 * Quando uma conversa NOVA bate numa regra de routing_rules com
 * skipQueue=true (ver lib/autoRouter.ts), este módulo tenta atribuir ela na
 * hora a um vendedor ocioso do setor da regra — sem esperar ninguém clicar
 * (diferente da fila normal, que só auto-atribui se a linha de WhatsApp
 * tiver queueAutoAssignEnabled ligado, ver queueAutoAssign.ts). Se não achar
 * ninguém elegível, a conversa cai no pool normal do setor (Potenciais/
 * Pendentes) — um vendedor ainda pode assumir manualmente pelo /claim de
 * sempre, exatamente como pedido ("permitir iniciar atendimento
 * manualmente" vira o caminho de reserva quando o automático não acha
 * ninguém livre).
 *
 * Elegibilidade de vendedor:
 *  - "vendedor" ativo, no MESMO setor da regra (sectorId primário ou algum
 *    dos sectorIds, pedido 17/09 de vendedor em mais de um setor).
 *  - loja dele com stores.skipQueueEnabled=true (pedido 18/09: "criar botão
 *    para ativar" — por loja, não por linha de WhatsApp nem tenant inteiro).
 *    Uma conversa em si não tem loja definida antes de atribuída, então é
 *    a loja do VENDEDOR candidato que decide se ele participa, não a
 *    conversa.
 *  - SEM nenhuma conversa "pular_fila" já aberta com ele agora — o limite
 *    "1 por vez" pedido: só entra na roda de novo depois de finalizar (ou
 *    perder) a que pulou a fila antes.
 *
 * Entre os elegíveis, roda um rodízio pelo mesmo relógio de "última vez que
 * recebeu algo automático" que a fila normal já usa
 * (chatQueueLastAssignedAt) — evita empilhar tudo sempre no mesmo vendedor.
 */
import { db, conversationsTable, usersTable, storesTable } from "@workspace/db";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { restrictedRecipients, nextQueueNumber } from "./conversationScope";

type ConversationRow = typeof conversationsTable.$inferSelect;

async function hasActiveSkipQueueConversation(tenantId: number, vendorId: number): Promise<boolean> {
  const [row] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.assigneeId, vendorId),
      eq(conversationsTable.origin, "pular_fila"),
      notInArray(conversationsTable.status, ["resolved", "archived"]),
    )).limit(1);
  return !!row;
}

async function findVendorForSkipQueue(tenantId: number, sectorId: number): Promise<number | null> {
  const candidates = await db.select({
    id: usersTable.id,
    sectorId: usersTable.sectorId,
    sectorIds: usersTable.sectorIds,
    storeId: usersTable.storeId,
  })
    .from(usersTable)
    .where(and(
      eq(usersTable.tenantId, tenantId),
      eq(usersTable.role, "vendedor"),
      eq(usersTable.isActive, true),
    ))
    .orderBy(sql`${usersTable.chatQueueLastAssignedAt} ASC NULLS FIRST`);

  const inSector = candidates.filter((c) => c.sectorId === sectorId || (c.sectorIds ?? []).includes(sectorId));
  if (inSector.length === 0) return null;

  const storeIds = [...new Set(inSector.map((c) => c.storeId).filter((id): id is number => id != null))];
  if (storeIds.length === 0) return null;
  const enabledStores = await db.select({ id: storesTable.id }).from(storesTable)
    .where(and(inArray(storesTable.id, storeIds), eq(storesTable.skipQueueEnabled, true)));
  const enabledStoreIds = new Set(enabledStores.map((s) => s.id));
  if (enabledStoreIds.size === 0) return null;

  for (const c of inSector) {
    if (c.storeId == null || !enabledStoreIds.has(c.storeId)) continue;
    if (await hasActiveSkipQueueConversation(tenantId, c.id)) continue;
    return c.id;
  }
  return null;
}

// Mesmo padrão de atribuição condicional (`WHERE assignee_id IS NULL`) do
// /claim manual e do auto-atribuir normal — protege contra dois gatilhos
// (ex.: webhook duplicado) pegando a mesma conversa ao mesmo tempo.
async function atomicAssignSkipQueue(tenantId: number, conversationId: number, vendorId: number): Promise<ConversationRow | null> {
  const [vendor] = await db.select({ storeId: usersTable.storeId }).from(usersTable)
    .where(eq(usersTable.id, vendorId)).limit(1);
  const queueNumber = await nextQueueNumber(tenantId, vendor?.storeId ?? null);
  const [updated] = await db.update(conversationsTable)
    .set({
      assigneeId: vendorId,
      status: "open",
      attendanceStartedAt: new Date(),
      updatedAt: new Date(),
      origin: "pular_fila",
      queueNumber,
      storeId: vendor?.storeId ?? null,
    })
    .where(and(eq(conversationsTable.id, conversationId), isNull(conversationsTable.assigneeId)))
    .returning();
  return updated ?? null;
}

async function markVendorServed(vendorId: number): Promise<void> {
  await db.update(usersTable).set({ chatQueueLastAssignedAt: new Date() }).where(eq(usersTable.id, vendorId));
}

async function notifyAssigned(updated: ConversationRow): Promise<void> {
  const restrictedTo = await restrictedRecipients(updated);
  broadcast("conversation_updated", updated, {
    tenantId: updated.tenantId,
    sectorId: updated.sectorId,
    sessionKey: updated.sessionKey,
    isPotential: false,
    restrictedTo,
  });
}

/** Chame logo depois de criar uma conversa nova cuja regra de roteamento
 * bateu com skipQueue=true. Retorna true se conseguiu atribuir na hora
 * (o chamador não precisa fazer mais nada); false se não achou ninguém
 * elegível — a conversa já foi criada normalmente e fica no pool do setor,
 * esperando alguém assumir manualmente (o /claim de sempre). Nunca lança. */
export async function tryAssignSkipQueue(conv: { id: number; tenantId: number; sectorId: number }): Promise<boolean> {
  try {
    const vendorId = await findVendorForSkipQueue(conv.tenantId, conv.sectorId);
    if (!vendorId) return false;
    const updated = await atomicAssignSkipQueue(conv.tenantId, conv.id, vendorId);
    if (!updated) return false; // outro processo já pegou essa conversa
    await markVendorServed(vendorId);
    await notifyAssigned(updated);
    return true;
  } catch (err) {
    console.error("[skipQueueAssign] falha ao atribuir conversa de pular-fila:", err);
    return false;
  }
}
