/**
 * Auto-atribuição da fila do Central de Atendimento (pedido 14/09).
 *
 * A opção "Usar fila no Central de Atendimento" (chatQueueSingleTask, ver
 * schema/users.ts) já deixava o vendedor se auto-servir: com 0 atendimentos
 * abertos, ele via só o mais antigo do pool e clicava pra assumir. Este
 * arquivo automatiza esse último clique — quando habilitado POR LINHA de
 * WhatsApp (whatsappSessionsTable.queueAutoAssignEnabled, opt-in, default
 * desligado), o sistema mesmo atribui a conversa mais antiga do pool ao
 * vendedor ocioso, nos dois momentos pedidos:
 *
 *  1. `autoAssignOnNewPoolConversation` — assim que uma conversa ENTRA no
 *     pool sem responsável (cliente novo escrevendo, ou uma conversa
 *     reaberta/transferida que ficou sem dono).
 *  2. `autoAssignOnVendorFreed` — assim que um vendedor da fila FICA
 *     ocioso (finalizou o único atendimento aberto, teve ele
 *     transferido/removido) — pega pra ele, na hora, o mais antigo do pool.
 *
 * Sempre respeita (pedido explícito): separação por setor (nunca cruza
 * setor), a restrição de linha de WhatsApp do vendedor (allowedSessionKeys)
 * e um rodízio (chatQueueLastAssignedAt) entre vários vendedores ociosos do
 * mesmo setor, pra não empilhar tudo sempre no mesmo. A atribuição em si é
 * sempre uma UPDATE condicional (`WHERE assignee_id IS NULL`), o mesmo
 * padrão do /claim manual — protege contra dois gatilhos disparando ao
 * mesmo tempo pra mesma conversa.
 */
import { db, conversationsTable, usersTable, whatsappSessionsTable } from "@workspace/db";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { restrictedRecipients, countActiveConversations, nextQueueNumber } from "./conversationScope";

type ConversationRow = typeof conversationsTable.$inferSelect;

async function isSessionQueueAutoAssignEnabled(tenantId: number, sessionKey: string): Promise<boolean> {
  const [row] = await db.select({ v: whatsappSessionsTable.queueAutoAssignEnabled })
    .from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.sessionKey, sessionKey), eq(whatsappSessionsTable.tenantId, tenantId)))
    .limit(1);
  return !!row?.v;
}

// Atribui a conversa a um vendedor SÓ SE ela ainda estiver sem responsável —
// protege contra corrida entre dois gatilhos (ex.: um webhook e um /claim
// manual) tentando pegar a mesma conversa ao mesmo tempo.
//
// Origem "fila" (pedido 14/09): todo atendimento que passa por aqui SAIU do
// pool via auto-atribuir (nunca via /claim manual, que marca isso por conta
// própria em chat.ts) — sempre marca origin="fila" + o número sequencial da
// loja do vendedor (mesmo helper usado pelo /claim, nextQueueNumber).
async function atomicAssign(tenantId: number, conversationId: number, vendorId: number): Promise<ConversationRow | null> {
  const [vendor] = await db.select({ storeId: usersTable.storeId }).from(usersTable)
    .where(eq(usersTable.id, vendorId)).limit(1);
  const queueNumber = await nextQueueNumber(tenantId, vendor?.storeId ?? null);
  const [updated] = await db.update(conversationsTable)
    .set({
      assigneeId: vendorId,
      status: "open",
      attendanceStartedAt: new Date(),
      updatedAt: new Date(),
      origin: "fila",
      queueNumber,
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

// Vendedor ocioso (0 atendimentos abertos, fila com auto-atribuir ligado)
// "há mais tempo esperando" no MESMO setor da conversa, que também pode ver
// essa linha de WhatsApp (allowedSessionKeys). Nunca cruza setor.
async function findIdleQueueVendor(tenantId: number, sectorId: number, sessionKey: string): Promise<number | null> {
  const candidates = await db.select({
    id: usersTable.id,
    allowedSessionKeys: usersTable.allowedSessionKeys,
  })
    .from(usersTable)
    .where(and(
      eq(usersTable.tenantId, tenantId),
      eq(usersTable.role, "vendedor"),
      eq(usersTable.isActive, true),
      eq(usersTable.chatQueueSingleTask, true),
      eq(usersTable.sectorId, sectorId),
      // Grupo de WhatsApp (@g.us) não conta como "atendimento aberto" pra
      // decidir se o vendedor está ocioso — mesmo motivo de
      // countActiveConversations em conversationScope.ts.
      sql`NOT EXISTS (
        SELECT 1 FROM ${conversationsTable}
        WHERE ${conversationsTable.assigneeId} = ${usersTable.id}
          AND ${conversationsTable.isArchived} = false
          AND ${conversationsTable.status} NOT IN ('resolved', 'archived')
          AND ${conversationsTable.phone} NOT LIKE '%@g.us'
      )`,
    ))
    .orderBy(sql`${usersTable.chatQueueLastAssignedAt} ASC NULLS FIRST`);

  for (const c of candidates) {
    if (c.allowedSessionKeys != null && !c.allowedSessionKeys.includes(sessionKey)) continue;
    return c.id;
  }
  return null;
}

// Conversa mais antiga do pool (sem responsável) do MESMO setor do
// vendedor, entre as linhas de WhatsApp que ele pode ver E que estão com o
// auto-atribuir ligado.
async function findPoolConversationForVendor(
  tenantId: number,
  sectorId: number,
  allowedSessionKeys: string[] | null,
): Promise<number | null> {
  const enabledLines = await db.select({ sessionKey: whatsappSessionsTable.sessionKey })
    .from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, tenantId), eq(whatsappSessionsTable.queueAutoAssignEnabled, true)));
  let keys = enabledLines.map((r) => r.sessionKey);
  if (keys.length === 0) return null;
  if (allowedSessionKeys != null) {
    keys = keys.filter((k) => allowedSessionKeys.includes(k));
    if (keys.length === 0) return null;
  }

  const [row] = await db.select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.isArchived, false),
      eq(conversationsTable.sectorId, sectorId),
      isNull(conversationsTable.assigneeId),
      notInArray(conversationsTable.status, ["resolved", "archived"]),
      inArray(conversationsTable.sessionKey, keys),
      // Grupo de WhatsApp nunca entra na fila automática — só conversa
      // individual de cliente (pedido 14/09).
      sql`${conversationsTable.phone} NOT LIKE '%@g.us'`,
    ))
    .orderBy(asc(conversationsTable.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Chame depois que uma conversa entra (ou volta a entrar) no pool sem
 * responsável — conversa nova de cliente desconhecido, reaberta pelo
 * próprio cliente, ou liberada por uma transferência de setor / remoção
 * manual do responsável. Nunca lança — falhas aqui não podem derrubar o
 * fluxo principal (recebimento de mensagem / PATCH da conversa). */
export async function autoAssignOnNewPoolConversation(conv: {
  id: number;
  tenantId: number;
  sectorId: number | null;
  sessionKey: string;
}): Promise<void> {
  try {
    if (conv.sectorId == null) return;
    if (!(await isSessionQueueAutoAssignEnabled(conv.tenantId, conv.sessionKey))) return;
    const vendorId = await findIdleQueueVendor(conv.tenantId, conv.sectorId, conv.sessionKey);
    if (!vendorId) return;
    const updated = await atomicAssign(conv.tenantId, conv.id, vendorId);
    if (!updated) return; // outro processo já pegou essa conversa
    await markVendorServed(vendorId);
    await notifyAssigned(updated);
  } catch (err) {
    console.error("[queueAutoAssign] falha ao atribuir conversa nova/liberada:", err);
  }
}

/** Chame depois que um vendedor com fila+auto-atribuir ligado fica com 0
 * atendimentos abertos (finalizou o último, teve um transferido/removido).
 * Pega pra ele, na hora, o mais antigo do pool do MESMO setor dele. Nunca
 * lança. */
export async function autoAssignOnVendorFreed(tenantId: number, vendorId: number): Promise<void> {
  try {
    const [vendor] = await db.select({
      sectorId: usersTable.sectorId,
      allowedSessionKeys: usersTable.allowedSessionKeys,
      chatQueueSingleTask: usersTable.chatQueueSingleTask,
      isActive: usersTable.isActive,
      role: usersTable.role,
    }).from(usersTable).where(and(eq(usersTable.id, vendorId), eq(usersTable.tenantId, tenantId))).limit(1);
    if (!vendor || vendor.role !== "vendedor" || !vendor.chatQueueSingleTask || !vendor.isActive || vendor.sectorId == null) return;
    // Confere de novo aqui (não só no chamador): se o vendedor ainda tem
    // outro atendimento aberto, não pega mais nada além dele.
    const activeCount = await countActiveConversations(tenantId, vendorId);
    if (activeCount > 0) return;
    const convId = await findPoolConversationForVendor(tenantId, vendor.sectorId, vendor.allowedSessionKeys);
    if (!convId) return;
    const updated = await atomicAssign(tenantId, convId, vendorId);
    if (!updated) return; // outro processo já pegou essa conversa
    await markVendorServed(vendorId);
    await notifyAssigned(updated);
  } catch (err) {
    console.error("[queueAutoAssign] falha ao preencher vendedor liberado:", err);
  }
}

/** Chamado periodicamente pelo agendador (ver scheduler.ts) — cobre o caso
 * que os dois gatilhos acima (conversa nova / vendedor liberado) NÃO
 * cobrem: um vendedor que já está ocioso (0 atendimentos abertos) mas nunca
 * passou por uma transição de estado que disparasse o auto-atribuir. Ex.:
 * acabou de marcar "Usar fila no Central de Atendimento" agora e já estava
 * zerado antes disso; ou a linha de WhatsApp só teve "Auto-atribuir da
 * fila" ligada agora, com conversas antigas já esperando no pool. Sem este
 * tick, esse vendedor ficaria zerado pra sempre até uma conversa nova
 * chegar — ele nunca "vira" ocioso de novo porque já está. Idempotente e
 * seguro rodar em qualquer cadência: cada atribuição é a mesma UPDATE
 * condicional (`WHERE assignee_id IS NULL`) dos outros gatilhos. Nunca lança. */
export async function fillIdleQueueVendors(): Promise<void> {
  try {
    const vendors = await db.select({
      id: usersTable.id,
      tenantId: usersTable.tenantId,
      sectorId: usersTable.sectorId,
      allowedSessionKeys: usersTable.allowedSessionKeys,
    })
      .from(usersTable)
      .where(and(
        eq(usersTable.role, "vendedor"),
        eq(usersTable.isActive, true),
        eq(usersTable.chatQueueSingleTask, true),
      ));
    for (const v of vendors) {
      try {
        if (v.sectorId == null) continue;
        const activeCount = await countActiveConversations(v.tenantId, v.id);
        if (activeCount > 0) continue;
        const convId = await findPoolConversationForVendor(v.tenantId, v.sectorId, v.allowedSessionKeys);
        if (!convId) continue;
        const updated = await atomicAssign(v.tenantId, convId, v.id);
        if (!updated) continue; // outro processo já pegou essa conversa
        await markVendorServed(v.id);
        await notifyAssigned(updated);
      } catch (err) {
        console.error("[queueAutoAssign] falha ao preencher vendedor ocioso (tick):", err, { vendorId: v.id });
      }
    }
  } catch (err) {
    console.error("[queueAutoAssign] tick de preenchimento de ociosos falhou:", err);
  }
}
